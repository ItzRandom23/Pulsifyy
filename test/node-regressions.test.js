"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { nodeMock, managed, rawTrack, track, until, voiceServer, voiceState } = require("./protocol-fixture");

function remotePlayer(backend) {
  return backend.sessions.get(backend.sessionId).get("42");
}

function finish(backend) {
  const remote = remotePlayer(backend);
  const finished = remote.track;
  remote.track = null;
  backend.event("42", "TrackEndEvent", finished, "finished");
}

function voiceClosed(backend) {
  backend.socket.send(JSON.stringify({ op: "event", type: "WebSocketClosedEvent", guildId: "42", code: 4006 }));
}

test("trackEnd listener volume changes allow queue advancement and queueEnd", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42" });
  player.queue.add([track("first"), track("second")]);
  await player.play();
  let volumeOperation;
  manager.once("trackEnd", current => { volumeOperation = current.setVolume(25); });
  finish(backend);
  await until(() => player.queue.current?.track === "second" && player.playing);
  await volumeOperation;
  assert.equal(remotePlayer(backend).track.encoded, "second");
  assert.equal(remotePlayer(backend).volume, 25);

  manager.once("trackEnd", current => { volumeOperation = current.setVolume(30); });
  const queueEnd = once(manager, "queueEnd", { signal: AbortSignal.timeout(3000) });
  finish(backend);
  const [, ended] = await queueEnd;
  await volumeOperation;
  assert.equal(ended.track, "second");
  assert.equal(player.queue.current, null);
  assert.equal(player.volume, 30);
});

test("manual playback from a trackEnd listener is preserved", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42" });
  player.queue.add([track("first"), track("second")]);
  await player.play();
  let manual;
  manager.once("trackEnd", current => { manual = current.play(track("manual")); });
  finish(backend);
  await until(() => player.queue.current?.track === "manual" && player.playing);
  await manual;
  await player.eventQueue;
  assert.equal(remotePlayer(backend).track.encoded, "manual");
  assert.deepEqual(backend.requests.filter(request => request.body?.track?.encoded)
    .map(request => request.body.track.encoded), ["first", "manual"]);
});

test("queue advancement retries a transient rejection with the same playback ID", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options], { trackRetryAttempts: 1 });
  const player = manager.create({ guildId: "42" });
  player.queue.add([track("first"), track("second")]);
  await player.play();
  let rejected = false;
  backend.respond = ({ body, reply }) => {
    if (body?.track?.encoded !== "second" || rejected) return false;
    rejected = true;
    reply(503, { message: "Temporary fixture rejection" });
    return true;
  };
  finish(backend);
  await until(() => player.queue.current?.track === "second" && player.playing);
  const requests = backend.requests.filter(request => request.body?.track?.encoded === "second");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.searchParams.get("noReplace"), "false");
  assert.equal(requests[1].url.searchParams.get("noReplace"), "true");
  assert.ok(player.playbackId);
  assert.equal(requests[0].body.track.userData.pulsifyPlaybackId, player.playbackId);
  assert.equal(requests[1].body.track.userData.pulsifyPlaybackId, player.playbackId);
});

test("a lost response after successful playback does not restart the next track", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options], { trackRetryAttempts: 1 });
  const player = manager.create({ guildId: "42" });
  player.queue.add([track("first"), track("second")]);
  await player.play();
  let started;
  backend.respond = ({ body, response }) => {
    if (body?.track?.encoded !== "second" || started) return false;
    started = { ...rawTrack("second"), userData: body.track.userData };
    remotePlayer(backend).track = started;
    response.destroy();
    return true;
  };
  finish(backend);
  await until(() => player.queue.current?.track === "second" && player.playing);
  const requests = backend.requests.filter(request => request.body?.track?.encoded === "second");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url.searchParams.get("noReplace"), "true");
  assert.equal(remotePlayer(backend).track, started);
  assert.equal(player.playbackId, started.userData.pulsifyPlaybackId);
});

test("queue advancement preserves the next track when retry attempts are exhausted", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options], { trackRetryAttempts: 1 });
  const player = manager.create({ guildId: "42" });
  player.queue.add([track("first"), track("second"), track("third")]);
  await player.play();
  backend.respond = ({ body, reply }) => {
    if (body?.track?.encoded !== "second") return false;
    reply(503, { message: "Fixture remains unavailable" });
    return true;
  };
  const failure = once(manager, "nodeError", { signal: AbortSignal.timeout(3000) });
  finish(backend);
  const [, error] = await failure;
  await player.eventQueue;
  assert.equal(error.status, 503);
  assert.equal(player.playing, false);
  assert.equal(player.queue.current.track, "second");
  assert.equal(player.queue[0].track, "third");
  assert.equal(backend.requests.filter(request => request.body?.track?.encoded === "second").length, 2);
});

test("dynamic repeat keeps tracks in rotation through a full cycle", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42" });
  player.queue.add([track("first"), track("second"), track("third")]);
  player.setDynamicRepeat(true, 60000);
  await player.play();
  for (const next of ["second", "third", "first"]) {
    finish(backend);
    await until(() => player.queue.current?.track === next && player.playing);
    assert.equal(remotePlayer(backend).track.encoded, next);
    assert.equal(player.queue.length, 2);
  }
});

test("an old stuck event cannot stop a newer playback of the same track", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  let markStarted, completeRecovery;
  const started = new Promise(resolve => { markStarted = resolve; });
  const recovery = new Promise(resolve => { completeRecovery = resolve; });
  const { manager } = await managed(t, [backend.options], {
    trackErrorRecovery() {
      markStarted();
      return recovery;
    },
  });
  const player = manager.create({ guildId: "42" });
  player.queue.add(track("first"));
  await player.play();
  const firstPlaybackId = player.playbackId;
  backend.event("42", "TrackStuckEvent", remotePlayer(backend).track);
  await started;
  try {
    await player.restart();
    assert.notEqual(player.playbackId, firstPlaybackId);
  } finally {
    completeRecovery(false);
  }
  await player.eventQueue;
  assert.equal(remotePlayer(backend).track.userData.pulsifyPlaybackId, player.playbackId);
  assert.equal(backend.requests.some(request => request.body?.track?.encoded === null), false);
});

test("node destruction tries another ready target when the first refuses playback", { timeout: 8000 }, async t => {
  const origin = await nodeMock(t);
  const refusing = await nodeMock(t);
  const healthy = await nodeMock(t);
  const { manager } = await managed(t, [origin.options, refusing.options, healthy.options]);
  const player = manager.create({ guildId: "42", voiceChannelId: "55", node: origin.options.identifier });
  player.connect();
  await manager.updateVoiceState(voiceState("42", "55"));
  await manager.updateVoiceState(voiceServer("42"));
  player.queue.add([track("first"), track("second")]);
  await player.play();
  refusing.respond = ({ method, url, reply }) => {
    if (method !== "PATCH" || !url.pathname.includes("/players/")) return false;
    reply(503, { message: "Fixture refuses failover" });
    return true;
  };
  await manager.destroyNode(origin.options.identifier);
  assert.equal(manager.players.get("42"), player);
  assert.equal(player.node.options.identifier, healthy.options.identifier);
  assert.equal(remotePlayer(healthy).track.encoded, "first");
  assert.equal(player.queue[0].track, "second");
  assert.equal(refusing.requests.filter(request => request.body?.track?.encoded === "first").length, 1);
  assert.equal(manager.failoverReservations.size, 0);
});

test("voice recovery can retry on a later close after a failed REST resync", { timeout: 10000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42", voiceChannelId: "55" });
  player.connect();
  await manager.updateVoiceState(voiceState("42", "55"));
  await manager.updateVoiceState(voiceServer("42"));
  player.queue.add(track("first"));
  await player.play();
  const originalPlaybackId = player.playbackId;
  let attempts = 0;
  backend.respond = ({ body, reply }) => {
    if (body?.track?.encoded !== "first" || ++attempts !== 1) return false;
    reply(503, { message: "Fixture resync refused" });
    return true;
  };
  const failedResync = once(manager, "nodeError", { signal: AbortSignal.timeout(6000) });
  voiceClosed(backend);
  const [, error] = await failedResync;
  assert.equal(error.status, 503);
  assert.equal(player.voiceRecoveryAttempted, false);
  voiceClosed(backend);
  await until(() => attempts === 2 && player.playbackId !== originalPlaybackId);
  assert.equal(remotePlayer(backend).track.encoded, "first");
});

test("an already reconnected voice player cancels scheduled resync", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42", voiceChannelId: "55" });
  const notified = once(manager, "socketClosed", { signal: AbortSignal.timeout(3000) });
  voiceClosed(backend);
  await notified;
  await player.eventQueue;
  assert.ok(player.voiceRecoveryTimer);
  const updated = once(manager, "nodeRaw", { signal: AbortSignal.timeout(3000) });
  backend.socket.send(JSON.stringify({ op: "playerUpdate", guildId: "42", state: { connected: true, position: 0 } }));
  await updated;
  assert.equal(player.voiceRecoveryTimer, undefined);
  assert.equal(player.voiceRecoveryAttempted, false);
});

test("shutdown saves playback accepted while shutdown was starting", { timeout: 6000 }, async t => {
  const backend = await nodeMock(t);
  const root = await mkdtemp(join(tmpdir(), "pulsify-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { ...backend.options, enableSessionResumeOption: true, sessionTimeoutMs: 5000,
    apiRequestTimeoutMs: 3000 };
  const { manager } = await managed(t, [options], { sessionDataPath: root });
  const player = manager.create({ guildId: "42", voiceChannelId: "55" });
  player.connect();
  await player.play(track("first"));
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  backend.respond = async ({ body }) => {
    if (body?.track?.encoded === "second") {
      started.resolve();
      await response.promise;
    }
    return false;
  };

  const playing = player.play(track("second"));
  await started.promise;
  const shutdown = manager.handleShutdown();
  try {
    await until(() => player.destroyRequested);
  } finally {
    response.resolve();
  }
  await Promise.all([playing, shutdown]);
  assert.equal(remotePlayer(backend).track.encoded, "second");

  backend.sessions.delete(backend.sessionId);
  const { manager: replacement } = await managed(t, [options], { sessionDataPath: root });
  assert.equal(replacement.get("42").queue.current.track, "second");
  assert.equal(remotePlayer(backend).track.encoded, "second");
});
