"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { WebSocketServer } = require("ws");
const { Manager, TrackUtils } = require("pulsifyy");

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
    const preserveTrack = body.track && url.searchParams.get("noReplace") === "true" && player.track;
    if (body.track && !preserveTrack) {
      player.track = body.track.encoded == null ? null : { ...rawTrack(body.track.encoded), userData: body.track.userData };
    }
    for (const key of ["voice", "volume", "filters"]) {
      if (Object.hasOwn(body, key)) player[key] = body[key];
    }
    if (!preserveTrack) {
      if (body.paused !== undefined) player.paused = body.paused;
      if (body.position !== undefined) player.state.position = body.position;
    }
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

async function until(condition) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (condition()) return;
    await delay(8);
  }
  assert.fail("Timed out waiting for protocol state");
}

module.exports = { nodeMock, managed, rawTrack, track, until, voiceServer, voiceState };
