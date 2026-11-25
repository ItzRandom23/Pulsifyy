"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { StateTypes } = require("pulsifyy");
const { nodeMock, managed, track, until, voiceServer, voiceState } = require("./protocol-fixture");

const remotePlayer = (backend, player) => backend.sessions.get(backend.sessionId).get(player.guildId);

function emitFinished(backend, player) {
  const remote = remotePlayer(backend, player);
  const finished = { ...remote.track, encoded: remote.track.encoded + "-at-end" };
  remote.track = null;
  return player.node.handleEvent({ guildId: player.guildId, type: "TrackEndEvent", track: finished, reason: "finished" });
}

test("guild transfer preserves playback state and advances re-encoded tracks", { timeout: 10000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42", voiceChannelId: "10", textChannelId: "100", volume: 45 });
  player.queue.add([track("first"), track("second")]);
  await player.play({ startTime: 777 });
  await player.pause(true);
  const originalId = player.playbackId;

  const transferred = await player.switchGuild({ guildId: "43", voiceChannelId: "11", textChannelId: "101", volume: 5 });
  const remote = remotePlayer(backend, transferred);
  assert.equal(manager.get("42"), undefined);
  assert.equal(remotePlayer(backend, player), undefined);
  assert.equal(transferred.queue.current.track, "first");
  assert.deepEqual(transferred.queue.map(item => item.track), ["second"]);
  assert.equal(transferred.position, 777);
  assert.equal(remote.state.position, 777);
  assert.equal(transferred.volume, 5);
  assert.equal(remote.volume, 5);
  assert.equal(transferred.paused, true);
  assert.equal(remote.paused, true);
  assert.equal(transferred.playing, false);
  assert.ok(transferred.playbackId);
  assert.notEqual(transferred.playbackId, originalId);
  assert.equal(remote.track.userData.pulsifyPlaybackId, transferred.playbackId);

  await transferred.pause(false);
  await emitFinished(backend, transferred);
  assert.equal(remote.track.encoded, "second");
  assert.equal(transferred.playing, true);
});

test("opposing forced transfers settle without locking each other's guild", { timeout: 10000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const first = manager.create({ guildId: "42", voiceChannelId: "10", textChannelId: "100" });
  const second = manager.create({ guildId: "43", voiceChannelId: "11", textChannelId: "101" });
  first.queue.add(track("first"));
  second.queue.add(track("second"));
  await first.play();
  await second.play();

  const forward = first.switchGuild({ guildId: "43", voiceChannelId: "11", textChannelId: "101" }, true);
  const backward = second.switchGuild({ guildId: "42", voiceChannelId: "10", textChannelId: "100" }, true);
  await assert.rejects(backward, /transfer is already in progress/);
  const transferred = await forward;
  assert.equal(manager.get("43"), transferred);
  assert.equal(manager.get("42"), undefined);
  assert.equal(remotePlayer(backend, transferred).track.encoded, "first");

  const returned = await transferred.switchGuild({ guildId: "42", voiceChannelId: "10", textChannelId: "100" });
  assert.equal(manager.get("42"), returned);
  assert.equal(manager.get("43"), undefined);
});

test("node move cleans a destination player when sending the voice request throws", { timeout: 10000 }, async t => {
  const source = await nodeMock(t);
  const target = await nodeMock(t);
  const { manager } = await managed(t, [source.options, target.options], {
    send(guild, payload) {
      if (payload.d.channel_id) throw new Error("Discord gateway send failed.");
    },
  });
  const player = manager.create({ guildId: "42", voiceChannelId: "10", node: source.options.identifier });
  player.queue.add(track("first"));
  await player.play({ startTime: 777 });
  const playbackId = player.playbackId;

  await assert.rejects(player.moveNode(target.options.identifier), /Discord gateway send failed/);
  assert.equal(player.node.options.identifier, source.options.identifier);
  assert.equal(player.playbackId, playbackId);
  assert.equal(player.position, 777);
  assert.equal(remotePlayer(source, player).track.userData.pulsifyPlaybackId, playbackId);
  assert.equal(remotePlayer(target, player), undefined);
});

test("concurrent skips stop distinct playback IDs and leave the third track playing", { timeout: 10000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42" });
  player.queue.add([track("first"), track("second"), track("third")]);
  await player.play();
  const stoppedTracks = [];
  backend.respond = ({ body }) => {
    if (body?.track?.encoded === null) stoppedTracks.push(remotePlayer(backend, player).track);
    return false;
  };

  const first = player.stop();
  const second = player.stop();
  await first;
  assert.deepEqual(stoppedTracks.map(item => item.encoded), ["first"]);
  backend.event(player.guildId, "TrackEndEvent", stoppedTracks[0], "stopped");
  await second;
  assert.deepEqual(stoppedTracks.map(item => item.encoded), ["first", "second"]);
  assert.notEqual(stoppedTracks[0].userData.pulsifyPlaybackId, stoppedTracks[1].userData.pulsifyPlaybackId);
  backend.event(player.guildId, "TrackEndEvent", stoppedTracks[1], "stopped");
  await until(() => player.playing && player.queue.current?.track === "third");
});

test("skip advances after REST confirms an idle player without a terminal event", { timeout: 10000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42" });
  player.queue.add([track("first"), track("second")]);
  await player.play();
  const ended = remotePlayer(backend, player).track;
  let terminalEvents = 0;
  manager.on("trackEnd", () => { terminalEvents++; });

  await player.stop();
  await until(() => player.playing && player.queue.current?.track === "second");
  assert.equal(remotePlayer(backend, player).track.encoded, "second");
  assert.equal(terminalEvents, 1);
  await player.node.handleEvent({ guildId: player.guildId, type: "TrackEndEvent", reason: "stopped", track: ended });
  assert.equal(terminalEvents, 1);
  assert.equal(player.queue.current.track, "second");
});

test("destroy settles skips waiting for a missing terminal event", { timeout: 10000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42" });
  player.queue.add([track("first"), track("second")]);
  await player.play();
  await player.stop();
  const waiting = assert.rejects(player.stop(), /destroyed before the stop was confirmed/);
  await player.destroy();
  await waiting;
  assert.equal(player.pendingStop, undefined);
  assert.equal(player.queuedStops, 0);
});

test("voice connect retries one lost join and waits for Lavalink acknowledgement", { timeout: 10000 }, async t => {
  const backend = await nodeMock(t);
  const { manager, packets } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42", voiceChannelId: "10" });
  player.connect();
  player.connect();
  assert.equal(player.state, StateTypes.Connecting);
  assert.equal(packets.length, 1);

  await until(() => packets.length === 2);
  await manager.updateVoiceState(voiceState("42", "10"));
  assert.equal(player.state, StateTypes.Connecting);
  await manager.updateVoiceState(voiceServer("42"));
  assert.equal(player.state, StateTypes.Connected);
  assert.equal(player.pendingVoiceJoin, undefined);
  player.connect();
  assert.equal(packets.length, 2);
});

test("a rejected async Discord leave is handled while removing the player", { timeout: 10000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options], {
    async send(guild, packet) {
      if (packet.d.channel_id === null) throw new Error("Discord leave failed.");
    },
  });
  const player = manager.create({ guildId: "42", voiceChannelId: "10" });
  player.queue.add(track("first"));
  await player.play();

  await assert.rejects(player.destroy(), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /Discord leave failed/);
    return true;
  });
  assert.equal(manager.get("42"), undefined);
  assert.equal(remotePlayer(backend, player), undefined);
  assert.equal(player.state, StateTypes.Disconnected);
});

test("dynamic repeat rotates two tracks, can replay a sole track, and clears its timer when switched", { timeout: 10000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42" });
  player.queue.add([track("first"), track("second")]);
  player.setDynamicRepeat(true, 60_000);
  await player.play();

  await emitFinished(backend, player);
  assert.equal(player.queue.current.track, "second");
  assert.deepEqual(player.queue.map(item => item.track), ["first"]);
  await emitFinished(backend, player);
  assert.equal(player.queue.current.track, "first");
  player.queue.clear();
  const previousPlayback = player.playbackId;
  await emitFinished(backend, player);
  assert.equal(player.queue.current.track, "first");
  assert.notEqual(player.playbackId, previousPlayback);
  player.setTrackRepeat(true);
  assert.equal(player.dynamicLoopInterval, null);
  assert.equal(player.dynamicRepeatIntervalMs, null);
});

test("requester block shuffle keeps each requester's tracks adjacent", { timeout: 10000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42" });
  const requested = (name, id) => ({ ...track(name), requester: { id } });
  player.queue.add([track("current"), requested("a1", "11"), requested("b1", "22"),
    requested("a2", "11"), requested("b2", "22")]);

  player.queue.userBlockShuffle();
  const ordered = player.queue.map(item => item.track);
  assert.ok(
    ordered.join(",") === "a1,a2,b1,b2" || ordered.join(",") === "b1,b2,a1,a2",
    ordered.join(","),
  );
  assert.equal(player.queue.current.track, "current");
});
