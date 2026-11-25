"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const { WebSocketServer } = require("ws");
const { AutoPlayPlatform, LoadTypes, Manager, SearchPlatform, TrackUtils, TrackPartial } = require("pulsifyy");

const rawTrack = encoded => ({
  encoded, info: { title: encoded, identifier: encoded, author: "Artist", length: 9000,
    sourceName: "soundcloud", isSeekable: true, isStream: false, uri: null }, pluginInfo: {},
});
const track = encoded => TrackUtils.build(rawTrack(encoded));
const managersByTest = new WeakMap();
const serversByTest = new WeakMap();

async function nodeMock(t) {
  if (!managersByTest.has(t)) {
    const managers = [];
    const servers = [];
    managersByTest.set(t, managers);
    serversByTest.set(t, servers);
    t.after(async () => {
      const results = await Promise.allSettled(managers.map(manager => manager.handleShutdown()));
      await Promise.all(servers.map(close => close()));
      for (const result of results) if (result.status === "rejected") throw result.reason;
    });
  }
  const password = "fixture-lavalink";
  const state = { sessions: new Map(), requests: [], headers: [], generation: 0, password };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    const url = new URL(request.url, "http://localhost");
    const method = request.method;
    state.requests.push({ method, path: url.pathname, body, url });
    const reply = (status, data) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(data === undefined ? undefined : JSON.stringify(data));
    };
    if (request.headers.authorization !== password) return reply(401, { message: "Unauthorized" });
    if (state.respond && await state.respond({ method, url, body, reply, response })) return;
    if (url.pathname === "/v4/info") return reply(200, { sourceManagers: ["soundcloud", "spotify"], plugins: [] });
    if (url.pathname === "/v4/loadtracks") return reply(200, { loadType: "track", data: rawTrack(url.searchParams.get("identifier")) });
    if (url.pathname === "/v4/decodetracks") return reply(200, body.map(rawTrack));
    const route = /^\/v4\/sessions\/([^/]+)(?:\/(players)(?:\/(\d+))?)?$/.exec(url.pathname);
    if (!route) return reply(404, { message: "Route not found" });
    const session = state.sessions.get(route[1]);
    if (!session) return reply(404, { message: "Session not found" });
    if (!route[2]) return reply(200, body);
    const guild = route[3];
    if (!guild) return reply(200, [...session.values()]);
    if (method === "DELETE") {
      return session.delete(guild) ? reply(204) : reply(404, { message: "Player not found" });
    }
    const player = session.get(guild) ?? { guildId: guild, volume: 100, state: { position: 0 }, voice: {}, track: null };
    if (method === "GET") return reply(200, player);
    if (body.track && !(url.searchParams.get("noReplace") === "true" && player.track)) {
      player.track = body.track.encoded == null ? null : { ...rawTrack(body.track.encoded), userData: body.track.userData };
    }
    for (const key of ["voice", "volume", "filters", "paused"]) {
      if (Object.hasOwn(body, key)) player[key] = body[key];
    }
    if (body.position !== undefined) player.state.position = body.position;
    session.set(guild, player);
    return reply(200, player);
  });
  const sockets = new WebSocketServer({ server, path: "/v4/websocket" });
  sockets.on("connection", (socket, request) => {
    state.headers.push(request.headers);
    state.socket = socket;
    const previous = request.headers["session-id"];
    const resumed = state.sessions.has(previous);
    state.sessionId = resumed ? previous : "session" + (++state.generation);
    if (!resumed) state.sessions.set(state.sessionId, new Map());
    if (!state.suppressReady) socket.send(JSON.stringify({ op: "ready", resumed, sessionId: state.sessionId }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  serversByTest.get(t).push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  state.options = { host: "127.0.0.1", port: server.address().port, identifier: String(server.address().port),
    password, apiRequestTimeoutMs: 400, retryDelayMs: 10, maxRetryAttempts: 2 };
  state.event = (guildId, type, eventTrack, reason) => {
    state.socket.send(JSON.stringify({ op: "event", guildId, type, track: eventTrack, reason }));
  };
  return state;
}

async function managed(t, nodes, options = {}, clientId = "111") {
  const packets = [];
  const manager = new Manager({ nodes, send: (guild, payload) => packets.push({ guild, payload }), ...options });
  const ready = Promise.all([...manager.nodes.values()].map(node => {
    return new Promise(resolve => {
      const listener = connected => {
        if (node === connected) { manager.off("nodeConnect", listener); resolve(); }
      };
      manager.on("nodeConnect", listener);
    });
  }));
  managersByTest.get(t).push(manager);
  manager.init(clientId);
  await ready;
  return { manager, packets };
}

const voiceServer = (guild, endpoint = "voice.fixture") => ({ t: "VOICE_SERVER_UPDATE", d: { guild_id: guild, endpoint, token: "fixture-voice" } });
const voiceState = (guild, channel, user = "111") => ({ t: "VOICE_STATE_UPDATE", d: { guild_id: guild, user_id: user, channel_id: channel, session_id: "voice-session" } });

test("voice packet ordering, guild isolation and retry after a failed voice update", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager, packets } = await managed(t, [backend.options]);
  const a = manager.create({ guildId: "42", voiceChannelId: "55" });
  const b = manager.create({ guildId: "43", voiceChannelId: "56" });
  a.connect();
  a.connect();
  b.connect();
  assert.deepEqual(packets.map(({ guild }) => guild), ["42", "43"]);
  await manager.updateVoiceState(voiceServer("42"));
  await manager.updateVoiceState(voiceState("42", "55", "222"));
  let fail = true;
  backend.respond = ({ body, reply }) => {
    if (!body?.voice || !fail) return false;
    fail = false;
    reply(503, { message: body.voice.token });
    return true;
  };
  await assert.rejects(manager.updateVoiceState(voiceState("42", "55")), error => {
    assert.equal(error.status, 503);
    assert.ok(!String(error).includes("fixture-voice"));
    assert.equal(error.cause, undefined);
    return true;
  });
  await Promise.all([manager.updateVoiceState(voiceState("42", "55")), manager.updateVoiceState(voiceServer("42"))]);
  await manager.updateVoiceState(voiceState("43", "56"));
  await manager.updateVoiceState(voiceServer("43"));
  const remote = backend.sessions.get(backend.sessionId);
  assert.equal(remote.get("42").voice.channelId, "55");
  assert.equal(remote.get("43").voice.channelId, "56");
  assert.equal(backend.requests.filter(r => r.body?.voice).length, 3);
  a.setVoiceChannelId("57");
  await manager.updateVoiceState(voiceServer("42", "voice-next.fixture"));
  assert.equal(remote.get("42").voice.channelId, "55");
  await manager.updateVoiceState(voiceState("42", "57"));
  assert.equal(remote.get("42").voice.channelId, "57");
  assert.equal(remote.get("42").voice.endpoint, "voice-next.fixture");
  await manager.updateVoiceState(voiceState("42", null));
  assert.equal(manager.get("42"), undefined);
  assert.equal(remote.has("42"), false);
  assert.ok(manager.get("43"));
});

test("player controls serialize, apply v4 options, and preserve state on rejection", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42", volume: 0 });
  player.queue.add(track("a"));
  await player.play({ startTime: 25 });
  assert.equal(player.position, 25);
  assert.deepEqual(backend.requests.at(-1).body.track.encoded, "a");
  assert.equal(backend.requests.at(-1).body.volume, 0);
  assert.ok(!Object.hasOwn(backend.requests.at(-1).body, "encodedTrack"));
  await player.play(track("b"), { noReplace: true });
  assert.equal(player.queue.current.track, "a");
  await Promise.all([player.pause(true), player.pause(false), player.seek(50), player.setVolume(100)]);
  assert.equal(player.paused, false);
  assert.equal(player.position, 50);
  assert.equal(player.volume, 100);
  backend.respond = ({ reply }) => { reply(502, { message: "Failed" }); return true; };
  await assert.rejects(player.setVolume(150), /HTTP 502/);
  assert.equal(player.volume, 100);
  backend.respond = undefined;
  assert.strictEqual(player.destroy(), player.destroy());
  assert.equal(await player.destroy(), true);
  assert.equal(manager.players.size, 0);
  await assert.rejects(player.play(track("late")), /destroyed/);
});

test("duplicate and stale events do not skip repeated encodings or fire queueEnd twice", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42" });
  const remote = () => backend.sessions.get(backend.sessionId).get("42").track;
  player.queue.add([track("a"), track("a"), track("b")]);
  await player.play();
  const first = remote();
  let starts = 0;
  let ends = 0;
  manager.on("trackStart", () => starts++);
  manager.on("queueEnd", () => ends++);
  backend.event("42", "TrackStartEvent", first);
  backend.event("42", "TrackStartEvent", first);
  backend.event("42", "TrackEndEvent", first, "finished");
  backend.event("42", "TrackEndEvent", first, "finished");
  await until(() => remote().userData.pulsifyPlaybackId !== first.userData.pulsifyPlaybackId);
  assert.equal(remote().encoded, "a");
  backend.event("42", "TrackEndEvent", remote(), "finished");
  await until(() => remote().encoded === "b");
  backend.event("42", "TrackEndEvent", remote(), "finished");
  backend.event("42", "TrackEndEvent", remote(), "finished");
  await until(() => ends === 1);
  assert.equal(player.queue.current, null);
  player.queue.add(track("c"));
  await player.play();
  backend.event("42", "TrackEndEvent", remote(), "finished");
  await until(() => ends === 2);
  assert.equal(starts, 1);
});

test("load failures retry a bounded number of times and then advance once", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options], { trackRetryAttempts: 1 });
  const player = manager.create({ guildId: "42" });
  const remote = () => backend.sessions.get(backend.sessionId).get("42").track;
  player.queue.add([track("a"), track("b")]);
  await player.play();
  const first = remote();
  backend.event("42", "TrackExceptionEvent", first);
  backend.event("42", "TrackEndEvent", first, "loadFailed");
  await until(() => remote().userData.pulsifyPlaybackId !== first.userData.pulsifyPlaybackId);
  const retry = remote();
  backend.event("42", "TrackStartEvent", retry);
  backend.event("42", "TrackEndEvent", retry, "loadFailed");
  await until(() => remote().encoded === "b");
  assert.equal(backend.requests.filter(r => r.body?.track?.encoded === "a").length, 2);
});

test("autoplay uses recommendations from the player's node and stops when disabled", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options], { autoPlaySearchPlatforms: [AutoPlayPlatform.Spotify] });
  const player = manager.create({ guildId: "42" });
  const rawSeed = rawTrack("seed");
  rawSeed.info.sourceName = "spotify";
  const seed = TrackUtils.build(rawSeed, { id: "2" });
  player.setAutoplay(true, { id: "111" });
  backend.respond = ({ url, reply }) => {
    if (url.searchParams.get("identifier") !== "sprec:mix:track:seed") return false;
    reply(200, { loadType: "search", data: [rawSeed, rawTrack("recommendation")] });
    return true;
  };
  player.queue.add(seed);
  await player.play();
  const remote = () => backend.sessions.get(backend.sessionId).get("42").track;
  backend.event("42", "TrackEndEvent", remote(), "finished");
  await until(() => player.queue.current?.track === "recommendation");
  assert.equal(player.queue.current.requester.id, "111");
  player.setAutoplay(false);
  const ended = once(manager, "queueEnd");
  backend.event("42", "TrackEndEvent", remote(), "finished");
  await ended;
  assert.equal(player.queue.current, null);
  assert.deepEqual(player.autoplayPool, []);
});

test("filters update in order and clear their remote settings", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42" });
  const filters = player.filters;
  await filters.setEqualizer([{ band: 0, gain: 0.15 }]);
  await filters.setTimescale({ rate: 1, speed: 1.1, pitch: 1 });
  const remote = backend.sessions.get(backend.sessionId).get("42");
  assert.deepEqual(remote.filters.equalizer, [{ band: 0, gain: 0.15 }]);
  assert.equal(remote.filters.timescale.speed, 1.1);
  await filters.clearFilters();
  assert.deepEqual(remote.filters.equalizer, []);
  assert.equal(remote.filters.timescale, null);
});

test("an existing session resumes without replaying the active track", { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pulsify-test-"));
  const backend = await nodeMock(t);
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeOptions = { ...backend.options, enableSessionResumeOption: true, sessionTimeoutMs: 2500 };
  const { manager } = await managed(t, [nodeOptions], { sessionDataPath: root });
  const player = manager.create({ guildId: "42", voiceChannelId: "55" });
  player.connect();
  await manager.updateVoiceState(voiceState("42", "55"));
  await manager.updateVoiceState(voiceServer("42"));
  player.queue.add([track("a"), track("b")]);
  await player.play();
  const id = backend.sessionId;
  assert.deepEqual(backend.requests[0].body, { resuming: true, timeout: 3 });
  const reconnected = once(manager, "nodeConnect");
  backend.socket.terminate();
  await reconnected;
  assert.equal(backend.headers.at(-1)["session-id"], id);
  assert.equal(backend.requests.filter(r => r.body?.track?.encoded === "a").length, 1);
  await manager.handleShutdown();
  const saved = await readFile(join(root, "sessions", "111", "0", "players", "42.json"), "utf8");
  for (const absent of [backend.password, "fixture-voice", "voice-session", "voice.fixture"]) assert.ok(!saved.includes(absent));
  const { manager: replacement } = await managed(t, [nodeOptions], { sessionDataPath: root });
  const restored = replacement.get("42");
  assert.equal(restored.queue.current.track, "a");
  assert.equal(restored.queue[0].track, "b");
  assert.equal(backend.requests.filter(r => r.body?.track?.encoded === "a").length, 1);
  await replacement.handleShutdown();
});

test("an expired Lavalink session rebuilds recent local state on a new session", { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pulsify-fresh-"));
  const backend = await nodeMock(t);
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeOptions = { ...backend.options, enableSessionResumeOption: true, sessionTimeoutMs: 5000 };
  const { manager } = await managed(t, [nodeOptions], { sessionDataPath: root });
  const player = manager.create({ guildId: "42", voiceChannelId: "55" });
  player.connect();
  player.queue.add([track("a"), track("b")]);
  await player.play({ startTime: 100 });
  await player.pause(true);
  await manager.handleShutdown();
  const previousSession = backend.sessionId;
  backend.sessions.delete(previousSession);
  const { manager: replacement, packets } = await managed(t, [nodeOptions], { sessionDataPath: root });
  assert.notEqual(backend.sessionId, previousSession);
  const restored = replacement.get("42");
  assert.equal(restored.position, 100);
  assert.equal(restored.paused, true);
  assert.equal(restored.queue.current.track, "a");
  assert.equal(restored.queue[0].track, "b");
  assert.deepEqual(packets.map(packet => packet.payload.d.channel_id), ["55"]);
  await replacement.handleShutdown();
});

test("malformed JSON responses reject without changing player state", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "42" });
  backend.respond = ({ response }) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{");
    return true;
  };
  try {
    await assert.rejects(player.setVolume(150), /invalid response/);
    assert.equal(player.volume, 100);
  } finally { backend.respond = undefined; }
});

test("node failover preserves voice, track and volume and balances current assignments", { timeout: 5000 }, async t => {
  const [first, second, third] = await Promise.all([nodeMock(t), nodeMock(t), nodeMock(t)]);
  const { manager } = await managed(t, [first.options, second.options, third.options]);
  const players = [];
  for (let index = 1; index < 5; index++) {
    const guildId = String(index);
    const player = manager.create({ guildId, voiceChannelId: "55", node: first.options.identifier, volume: 18 });
    await manager.updateVoiceState(voiceServer(guildId));
    await manager.updateVoiceState(voiceState(guildId, "55"));
    player.queue.add(track(guildId));
    await player.play({ startTime: 12 });
    players.push(player);
  }
  first.socket.terminate();
  await until(() => players.every(player => player.node.options.identifier !== first.options.identifier) &&
    manager.failoverReservations.size === 0);
  for (const backend of [second, third]) {
    const remote = backend.sessions.get(backend.sessionId);
    assert.equal(remote.size, 2);
    for (const player of remote.values()) {
      assert.equal(player.volume, 18);
      assert.equal(player.voice.channelId, "55");
      assert.equal(player.state.position, 12);
      assert.equal(player.track.encoded, player.guildId);
    }
  }
  assert.equal(manager.failoverReservations.size, 0);
  assert.ok([...first.sessions.values()].every(session => session.size === 0));
});

test("same-node search deduplicates concurrent requests and isolates managers and callers", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager: first } = await managed(t, [backend.options], { trackPartial: [TrackPartial.Track], trackCacheMaxEntries: 2 });
  const { manager: second } = await managed(t, [backend.options], {}, "222");
  const calls = await Promise.all(Array.from({ length: 32 }, () => first.search("song", undefined, ["soundcloud"])));
  assert.deepEqual(calls[0].tracks[0], { track: "scsearch:song" });
  assert.equal(backend.requests.filter(r => r.path === "/v4/loadtracks").length, 1);
  const full = await second.search("song", undefined, ["soundcloud"]);
  assert.equal(full.tracks[0].title, "scsearch:song");
  full.tracks[0].title = "changed";
  assert.equal((await second.search("song", undefined, ["soundcloud"])).tracks[0].title, "scsearch:song");
  await first.search("other song");
  await first.search("third song");
  assert.equal(first.trackCache.size, 2);
  assert.strictEqual(first.create({ guildId: "42" }).manager, first);
  assert.strictEqual(second.create({ guildId: "42" }).manager, second);
});

test("Gaana searches use PulseLink's prefix with both the enum and the old prefix", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options], { defaultSearchPlatform: SearchPlatform.Gaana });
  assert.equal((await manager.search("first song")).tracks[0].track, "gnsearch:first song");
  assert.equal((await manager.search("second song", undefined, "gaana")).tracks[0].track, "gnsearch:second song");
  assert.equal((await manager.search("third song", undefined, "gasearch")).tracks[0].track, "gnsearch:third song");
});

test("YouTube and YouTube Music search and direct links use Lavalink identifiers", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options], { defaultSearchPlatform: SearchPlatform.YouTubeMusic });
  const link = "https://youtu.be/example";
  const musicLink = "https://music.youtube.com/watch?v=example";
  const calls = [
    ["video query", SearchPlatform.YouTube, "ytsearch:video query"],
    ["music query", undefined, "ytmsearch:music query"],
    ["music alias", "youtube music", "ytmsearch:music alias"],
    [link, [SearchPlatform.YouTube, SearchPlatform.YouTubeMusic], link],
    [musicLink, SearchPlatform.SoundCloud, musicLink],
  ];
  for (const [query, source, identifier] of calls) {
    const result = await manager.search(query, undefined, source);
    assert.equal(result.tracks[0].track, identifier);
  }
  assert.deepEqual(backend.requests.filter(r => r.path === "/v4/loadtracks")
    .map(r => r.url.searchParams.get("identifier")), calls.map(([, , identifier]) => identifier));
});

test("retired search and autoplay sources are skipped or rejected", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  assert.equal(SearchPlatform.AmazonMusic, undefined);
  assert.equal(SearchPlatform.Qobuz, undefined);
  assert.equal(AutoPlayPlatform.Qobuz, undefined);
  assert.throws(() => new Manager({ send() {}, autoPlaySearchPlatforms: ["qobuz"] }), /autoPlaySearchPlatforms/);

  const removed = ["AmazonMusic", "amzsearch", "Qobuz", "qbsearch"];
  const empty = await manager.search("song", undefined, removed);
  assert.equal(empty.loadType, LoadTypes.Empty);
  assert.ok(!backend.requests.some(r => r.path === "/v4/loadtracks"));
  const fallback = await manager.search("song", undefined, [...removed, SearchPlatform.YouTube]);
  assert.equal(fallback.tracks[0].track, "ytsearch:song");
});

test("missing ready frames exhaust the configured retry budget", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  backend.suppressReady = true;
  const manager = new Manager({ send() {}, nodes: [{ ...backend.options, apiRequestTimeoutMs: 60 }] });
  t.after(() => manager.handleShutdown());
  const done = once(manager, "nodeDestroy");
  manager.init("111");
  await done;
  assert.equal(backend.headers.length, 3);
  assert.equal(manager.nodes.size, 0);
});

test("queue validation, immutable inputs and cleanup across 1000 concurrent guilds", { timeout: 15000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options], { maxQueueSize: 4 });
  const started = performance.now();
  const source = Object.freeze([track("a"), track("b")]);
  const players = Array.from({ length: 1000 }, (_, i) => {
    const player = manager.create({ guildId: String(i + 1) });
    player.queue.add(source);
    return player;
  });
  const queue = players[0].queue;
  queue.add([track("c"), track("d")], 0);
  assert.deepEqual(queue.map(item => item.track), ["c", "d", "b"]);
  assert.throws(() => queue.add(track("extra")), /Queue limit/);
  assert.deepEqual(queue.remove(0, 2).map(item => item.track), ["c", "d"]);
  assert.equal(source.length, 2);
  assert.equal(manager.players.size, 1000);
  const setup = performance.now() - started;
  // These players have no remote tracks. Bound concurrent raw deletions to a few workers.
  await manager.handleShutdown();
  assert.equal(manager.players.size, 0);
  assert.equal(manager.nodes.size, 0);
  assert.equal(manager.inactivityTimer, undefined);
  t.diagnostic("Created and populated 1000 players in " + setup.toFixed(1) + " ms");
});

async function until(condition) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (condition()) return;
    await delay(8);
  }
  assert.fail("Timed out waiting for protocol state");
}
