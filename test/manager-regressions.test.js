"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp, readFile, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { AutoPlayPlatform, SearchPlatform } = require("pulsifyy");
const { nodeMock, managed, track, until, voiceServer, voiceState } = require("./protocol-fixture");

test("explicit undefined values keep the normal search, autoplay, and playback defaults", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options], {
    playNextOnEnd: undefined, defaultSearchPlatform: undefined, autoPlaySearchPlatforms: undefined,
  });
  assert.equal(manager.options.playNextOnEnd, true);
  assert.equal(manager.options.defaultSearchPlatform, SearchPlatform.Deezer);
  assert.ok(manager.options.autoPlaySearchPlatforms.includes(AutoPlayPlatform.Spotify));
  assert.equal((await manager.search("song")).tracks[0].track, "dzsearch:song");
});

test("concurrent playlist loads append one whole list or nothing at the queue limit", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options], { maxQueueSize: 4 });
  const player = manager.create({ guildId: "42" });
  manager.search = async prefix => ({ tracks: [1, 2, 3].map(index => track(prefix + index)) });
  const outcomes = await Promise.allSettled([
    manager.loadPlaylistInChunks(player, "a", undefined, undefined, 1),
    manager.loadPlaylistInChunks(player, "b", undefined, undefined, 1),
  ]);
  const winner = outcomes[0].status === "fulfilled" ? "a" : "b";
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.match(outcomes.find(outcome => outcome.status === "rejected").reason.message, /Queue limit exceeded/);
  assert.deepEqual([player.queue.current, ...player.queue].map(item => item.track), [1, 2, 3].map(index => winner + index));
});

test("externally moved voice channels pair the latest credentials in either packet order", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const guild = "42";
  const player = manager.create({ guildId: guild, voiceChannelId: "50" });
  const state = (channel, session) => {
    const packet = voiceState(guild, channel);
    packet.d.session_id = session;
    return packet;
  };
  const server = token => {
    const packet = voiceServer(guild);
    packet.d.token = token;
    return packet;
  };
  await manager.updateVoiceState(state("50", "initial"));
  await manager.updateVoiceState(server("fixture-initial"));
  await manager.updateVoiceState(server("fixture-first"));
  await manager.updateVoiceState(state("51", "server-first"));
  const remote = () => backend.sessions.get(backend.sessionId).get(guild).voice;
  assert.equal(remote().channelId, "51");
  assert.equal(remote().sessionId, "server-first");
  assert.equal(remote().token, "fixture-first");
  assert.equal(player.voiceChannelId, "51");

  const writes = backend.requests.length;
  await manager.updateVoiceState(state("52", "state-first"));
  assert.equal(backend.requests.length, writes);
  await manager.updateVoiceState(server("fixture-second"));
  assert.equal(remote().channelId, "52");
  assert.equal(remote().sessionId, "state-first");
  assert.equal(remote().token, "fixture-second");
});

test("a duplicate old voice state cannot cancel an outstanding local channel move", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager, packets } = await managed(t, [backend.options]);
  const guild = "42";
  const player = manager.create({ guildId: guild, voiceChannelId: "55" });
  player.connect();
  await manager.updateVoiceState(voiceState(guild, "55"));
  await manager.updateVoiceState(voiceServer(guild));

  player.setVoiceChannelId("56");
  await manager.updateVoiceState(voiceState(guild, "55"));
  assert.equal(player.voiceChannelId, "56");
  await until(() => packets.filter(packet => packet.payload.d.channel_id === "56").length === 2);

  const state = voiceState(guild, "56");
  state.d.session_id = "moved-voice-session";
  await manager.updateVoiceState(state);
  await manager.updateVoiceState(voiceServer(guild, "moved.fixture"));
  const remote = backend.sessions.get(backend.sessionId).get(guild);
  assert.equal(remote.voice.channelId, "56");
  assert.equal(remote.voice.endpoint, "moved.fixture");
  assert.equal(player.state, "CONNECTED");
});

async function savedSession(t) {
  const root = await mkdtemp(join(tmpdir(), "pulsify-resume-regression-"));
  const backend = await nodeMock(t);
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { ...backend.options, enableSessionResumeOption: true, sessionTimeoutMs: 30000 };
  const { manager } = await managed(t, [options], { sessionDataPath: root });
  const player = manager.create({ guildId: "42", voiceChannelId: "55" });
  player.connect();
  await manager.updateVoiceState(voiceState("42", "55"));
  await manager.updateVoiceState(voiceServer("42"));
  const first = track("first");
  first.requester = { id: "123" };
  player.queue.add([first, track("second")]);
  await player.play();
  const remote = backend.sessions.get(backend.sessionId).get("42");
  const file = join(root, "sessions", "111", "0", "players", "42.json");
  await manager.handleShutdown();
  return { root, backend, options, file, remote };
}

test("a buffered finish advances a saved queue without replaying its previous track", { timeout: 5000 }, async t => {
  const { root, backend, options, file, remote } = await savedSession(t);
  const first = { ...remote.track, encoded: "first-at-end-position" };
  const snapshot = JSON.parse(await readFile(file, "utf8"));
  assert.equal(snapshot.playbackId, first.userData.pulsifyPlaybackId);
  remote.track = null;
  let replayed = false;
  backend.respond = ({ method, body }) => {
    if (!replayed && method === "PATCH" && body?.resuming) {
      replayed = true;
      backend.event("42", "TrackEndEvent", first, "finished");
    }
    return false;
  };
  const { manager } = await managed(t, [options], { sessionDataPath: root });
  await until(() => manager.get("42")?.queue.current?.track === "second" && manager.get("42").playing);
  assert.equal(backend.requests.filter(request => request.body?.track?.encoded === "first").length, 1);
  assert.equal(backend.requests.filter(request => request.body?.track?.encoded === "second").length, 1);
});

test("an idle resumed player advances a legacy snapshot without a buffered finish", { timeout: 5000 }, async t => {
  const { root, backend, options, remote, file } = await savedSession(t);
  const legacy = JSON.parse(await readFile(file, "utf8"));
  delete legacy.playbackId;
  await writeFile(file, JSON.stringify(legacy), "utf8");
  remote.track = null;
  const { manager } = await managed(t, [options], { sessionDataPath: root });
  await until(() => manager.get("42")?.queue.current?.track === "second" && manager.get("42").playing);
  assert.equal(backend.requests.filter(request => request.body?.track?.encoded === "first").length, 1);
  assert.equal(backend.requests.filter(request => request.body?.track?.encoded === "second").length, 1);
});

test("a re-encoded active resumed track keeps its requester and upcoming tracks are rehydrated", { timeout: 5000 }, async t => {
  const { root, options, remote } = await savedSession(t);
  remote.track.encoded = "first-at-new-position";
  const { manager } = await managed(t, [options], { sessionDataPath: root });
  const player = manager.get("42");
  assert.equal(player.queue.current.requester.id, "123");
  assert.equal(player.queue.current.track, "first-at-new-position");
  assert.equal(player.queue[0].duration, 9000);
  assert.equal(player.queue[0].displayThumbnail(), null);
});

test("a resumed remote player remains controllable if its snapshot is missing", { timeout: 5000 }, async t => {
  const { root, backend, options, file } = await savedSession(t);
  await rm(file);
  const { manager } = await managed(t, [options], { sessionDataPath: root });
  const player = manager.get("42");
  assert.equal(player.queue.current.track, "first");
  assert.equal(player.voiceChannelId, "55");
  assert.equal(player.playing, true);
  await player.destroy();
  assert.equal(backend.sessions.get(backend.sessionId).has("42"), false);
});
