"use strict";
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { AutoPlayPlatform, AvailableFilters, Manager, TrackPartial, TrackUtils } = require("pulsifyy");
const { managed, nodeMock, rawTrack, until } = require("./protocol-fixture");

function loadedTrack(encoded, sourceName) {
  const track = rawTrack(encoded);
  track.info.sourceName = sourceName;
  return { loadType: "track", data: track };
}

function requests(backend, path) {
  return backend.requests.filter(request => request.path === path);
}

test("autoplay tries another provider when the first one's result repeats the seed", { timeout: 6000 }, async t => {
  const backend = await nodeMock(t);
  const lookups = [];
  backend.respond = ({ url, reply }) => {
    if (url.pathname === "/v4/info") {
      reply(200, { sourceManagers: ["spotify", "deezer"], plugins: [] });
      return true;
    }
    if (url.pathname !== "/v4/loadtracks") return false;
    const identifier = url.searchParams.get("identifier");
    lookups.push(identifier);
    if (identifier === "sprec:mix:track:seed") reply(200, loadedTrack("seed", "spotify"));
    else if (identifier.startsWith("dzsearch:")) reply(200, loadedTrack("seed-on-deezer", "deezer"));
    else if (identifier === "dzrec:seed-on-deezer") reply(200, loadedTrack("new-track", "deezer"));
    else reply(200, { loadType: "empty", data: null });
    return true;
  };
  const { manager } = await managed(t, [backend.options], {
    autoPlaySearchPlatforms: [AutoPlayPlatform.Spotify, AutoPlayPlatform.Deezer],
  });
  const player = manager.create({ guildId: "200" });
  player.setAutoplay(true, { id: "111" });
  const seed = TrackUtils.build(loadedTrack("seed", "spotify").data);
  assert.deepEqual((await player.refreshAutoplayPool(seed)).map(track => track.track), ["new-track"]);
  assert.deepEqual(lookups, ["sprec:mix:track:seed", "dzsearch:seed Artist", "dzrec:seed-on-deezer"]);
});

test("a replacement node with the same identifier does not reuse cached tracks", { timeout: 6000 }, async t => {
  const first = await nodeMock(t);
  const replacement = await nodeMock(t);
  const respond = encoded => ({ url, reply }) => {
    if (url.pathname !== "/v4/loadtracks") return false;
    reply(200, loadedTrack(encoded, "spotify"));
    return true;
  };
  first.respond = respond("old-track");
  replacement.respond = respond("new-track");

  const { manager } = await managed(t, [first.options]);
  const search = () => manager.search("test", undefined, ["spotify"]);
  assert.equal((await search()).tracks[0].track, "old-track");
  assert.equal((await search()).tracks[0].track, "old-track");
  assert.equal(requests(first, "/v4/loadtracks").length, 1);

  await manager.destroyNode(first.options.identifier);
  const ready = once(manager, "nodeConnect");
  manager.createNode({ ...replacement.options, identifier: first.options.identifier });
  await ready;
  assert.equal((await search()).tracks[0].track, "new-track");
  assert.equal(requests(replacement, "/v4/loadtracks").length, 1);
});

test("a resumed Lavalink session keeps its track cache but a new session loads tracks again", { timeout: 6000 }, async t => {
  const backend = await nodeMock(t);
  const directory = await mkdtemp(join(tmpdir(), "pulsify-session-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let encoding = "old-track";
  backend.respond = ({ url, reply }) => {
    if (url.pathname !== "/v4/loadtracks") return false;
    reply(200, loadedTrack(encoding, "soundcloud"));
    return true;
  };
  const options = { ...backend.options, enableSessionResumeOption: true };
  const { manager } = await managed(t, [options], { sessionDataPath: directory });
  const node = manager.nodes.get(options.identifier);
  const initialSession = node.sessionId;
  const search = async () => (await manager.search("test", undefined, "soundcloud")).tracks[0].track;
  assert.equal(await search(), "old-track");

  let ready = once(manager, "nodeConnect");
  backend.socket.terminate();
  assert.equal((await ready)[0], node);
  assert.equal(node.sessionId, initialSession);
  assert.equal(await search(), "old-track");
  assert.equal(requests(backend, "/v4/loadtracks").length, 1);

  backend.sessions.delete(initialSession);
  encoding = "fresh-track";
  ready = once(manager, "nodeConnect");
  backend.socket.terminate();
  assert.equal((await ready)[0], node);
  assert.notEqual(node.sessionId, initialSession);
  assert.equal(await search(), "fresh-track");
  assert.equal(requests(backend, "/v4/loadtracks").length, 2);
});

test("a load started before Lavalink is ready does not share the ready session's cache", { timeout: 6000 }, async t => {
  const backend = await nodeMock(t);
  const firstResponse = Promise.withResolvers();
  backend.respond = async ({ url, reply }) => {
    if (url.pathname !== "/v4/loadtracks") return false;
    const first = requests(backend, "/v4/loadtracks").length === 1;
    if (first) await firstResponse.promise;
    reply(200, loadedTrack(first ? "pre-session-track" : "ready-track", "soundcloud"));
    return true;
  };
  const options = { ...backend.options, apiRequestTimeoutMs: 2500 };
  const manager = new Manager({ nodes: [options], send: () => {}, trackCacheMaxEntries: 1 });
  const node = manager.nodes.get(options.identifier);
  const endpoint = "/v4/loadtracks?identifier=scsearch%3Atest";
  assert.equal(node.sessionId, undefined);
  const preSessionLoad = node.rest.get(endpoint);
  try {
    await until(() => requests(backend, "/v4/loadtracks").length === 1);
    const ready = once(manager, "nodeConnect");
    manager.init("111");
    await ready;
    assert.equal((await node.rest.get(endpoint)).data.encoded, "ready-track");
    firstResponse.resolve();
    assert.equal((await preSessionLoad).data.encoded, "pre-session-track");
    assert.equal((await node.rest.get(endpoint)).data.encoded, "ready-track");
    assert.equal(requests(backend, "/v4/loadtracks").length, 2);
  } finally {
    firstResponse.resolve();
    await Promise.allSettled([preSessionLoad, manager.handleShutdown()]);
  }
});

test("a rejected filter update leaves local settings and later patches intact", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "201" });
  const { filters } = player;
  backend.respond = ({ body, reply }) => {
    if (!body?.filters?.timescale) return false;
    reply(503, { message: "fixture filter rejection" });
    return true;
  };

  await assert.rejects(filters.nightcore(true), /HTTP 503/);
  assert.equal(filters.timescale, null);
  assert.equal(filters.getFilterStatus(AvailableFilters.Nightcore), false);
  await filters.setEqualizer([{ band: 0, gain: 0.1 }]);
  assert.equal(Object.hasOwn(backend.requests.at(-1).body.filters, "timescale"), false);
  assert.deepEqual(filters.equalizer, [{ band: 0, gain: 0.1 }]);
});

test("filter patches omit neutral effects while preserving the full filter snapshot", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const supported = ["equalizer", "timescale", "volume"];
  backend.respond = ({ url, body, reply }) => {
    if (url.pathname === "/v4/info") {
      reply(200, { sourceManagers: ["soundcloud"], plugins: [], filters: supported });
      return true;
    }
    if (!body?.filters || Object.keys(body.filters).every(name => supported.includes(name))) return false;
    reply(400, { message: "The supplied filter is disabled" });
    return true;
  };
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "205", voiceChannelId: "300" });
  const { filters } = player;

  await player.resyncState();
  assert.deepEqual(backend.requests.at(-1).body.filters, {});
  await filters.nightcore(true);
  const timescale = filters.timescale;
  assert.deepEqual(backend.requests.at(-1).body.filters, { timescale });
  const bands = [{ band: 0, gain: 0 }, { band: 1, gain: 0.1 }];
  await filters.setEqualizer(bands);
  assert.deepEqual(backend.requests.at(-1).body.filters, { timescale, equalizer: bands });

  filters.volume = 0;
  await filters.setEqualizer([{ band: 0, gain: 0 }]);
  assert.deepEqual(backend.requests.at(-1).body.filters, { timescale, volume: 0 });
  const snapshot = filters.snapshot();
  assert.equal(snapshot.karaoke, null);
  assert.equal(snapshot.tremoloOptions, null);
  assert.deepEqual(snapshot.equalizer, [{ band: 0, gain: 0 }]);
  assert.equal(snapshot.volume, 0);
  assert.deepEqual(snapshot.timescale, timescale);

  await assert.rejects(filters.setRotation({ rotationHz: 0.4 }), /HTTP 400/);
  assert.equal(filters.rotation, null);
  await filters.clearFilters();
  assert.deepEqual(backend.requests.at(-1).body.filters, {});
  assert.equal(filters.snapshot().volume, 1);
});

test("a superseded preset cannot clear a newer effect that shares its filter", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "202" });
  const { filters } = player;

  await Promise.all([filters.nightcore(true), filters.slowmo(true), filters.nightcore(false)]);
  assert.equal(filters.getFilterStatus(AvailableFilters.Nightcore), false);
  assert.equal(filters.getFilterStatus(AvailableFilters.Slowmo), true);
  assert.equal(filters.timescale.speed, 0.78);
  assert.equal(backend.requests.at(-1).body.filters.timescale.speed, 0.78);

  await filters.eightD(true);
  await filters.setRotation({ rotationHz: 0.4 });
  assert.equal(filters.getFilterStatus(AvailableFilters.EightD), false);
  assert.equal(filters.getFilterStatus(AvailableFilters.SetRotation), true);
  assert.equal(filters.channelMix, null);
  assert.equal(filters.timescale.speed, 0.78);
});

test("clearing the loudness preset restores the previous player volume", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "203" });
  const { filters } = player;
  await player.setVolume(60);
  await filters.earrape(true);
  assert.equal(player.volume, 200);

  backend.respond = ({ body, reply }) => {
    if (!body?.filters) return false;
    reply(503, { message: "fixture filter rejection" });
    return true;
  };
  await assert.rejects(filters.clearFilters(), /HTTP 503/);
  assert.equal(player.volume, 200);
  assert.equal(filters.getFilterStatus(AvailableFilters.Earrape), true);
  backend.respond = undefined;

  await filters.clearFilters();
  assert.equal(player.volume, 60);
  assert.equal(backend.requests.at(-1).body.volume, 60);
  assert.ok(backend.requests.at(-1).body.filters);
  assert.equal(filters.getFilterStatus(AvailableFilters.Earrape), false);
});

test("reverb reports unsupported settings and presets send standard Lavalink filters", { timeout: 5000 }, async t => {
  const backend = await nodeMock(t);
  const { manager } = await managed(t, [backend.options]);
  const player = manager.create({ guildId: "204" });
  const { filters } = player;
  const count = backend.requests.length;

  await assert.rejects(filters.setReverb({ wet: 0.2, dry: 0.8 }), /Reverb is not a built-in Lavalink v4 filter/);
  assert.equal(backend.requests.length, count);
  assert.equal(filters.getFilterStatus(AvailableFilters.SetReverb), false);
  await filters.vaporwave(true);
  const { filters: patch } = backend.requests.at(-1).body;
  assert.equal(Object.hasOwn(patch, "reverb"), false);
  assert.equal(patch.timescale.pitch, 0.85);
});

test("partial tracks preserve displayThumbnail without adding extra enumerable metadata", () => {
  const raw = rawTrack("partial");
  raw.info.artworkUrl = "https://artwork.invalid/partial";
  const withoutArtwork = TrackUtils.build(raw, undefined, [TrackPartial.Title]);
  const withArtwork = TrackUtils.build(raw, undefined, [TrackPartial.ArtworkUrl]);

  assert.deepEqual(Object.keys(withoutArtwork), ["track", "title"]);
  assert.equal(withoutArtwork.displayThumbnail(), null);
  assert.equal(withArtwork.displayThumbnail(), raw.info.artworkUrl);
});
