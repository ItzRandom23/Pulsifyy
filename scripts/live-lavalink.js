"use strict";
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { Manager } = require("pulsifyy");

async function main() {
  const password = process.env.LAVALINK_PASSWORD;
  if (!password) throw new Error("Set LAVALINK_PASSWORD for a dedicated Lavalink v4 test instance.");
  const sessionDataPath = await mkdtemp(join(tmpdir(), "pulsify-live-"));
  const audio = createServer((request, response) => {
    // A one-second mono PCM WAV fixture.
    const wav = Buffer.alloc(16044);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(16000, 40);
    response.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
    response.end(wav);
  });
  const manager = new Manager({
    nodes: [{ host: "127.0.0.1", port: Number(process.env.LAVALINK_PORT || 2333), password,
      enableSessionResumeOption: true, sessionTimeoutMs: 15000, retryDelayMs: 20, apiRequestTimeoutMs: 3000 }],
    sessionDataPath,
    send() {},
  });
  const errors = [];
  manager.on("nodeError", (node, error) => errors.push(error));
  const waitReady = () => once(manager, "nodeConnect", { signal: AbortSignal.timeout(6500) });
  try {
    audio.listen(0, "127.0.0.1");
    await once(audio, "listening");
    const ready = waitReady();
    manager.init("123456789123456789");
    const [node] = await ready;
    const session = node.sessionId;
    assert.equal((await node.rest.getAllPlayers()).length, 0);
    const result = await manager.search("http://127.0.0.1:" + audio.address().port + "/test.wav");
    assert.equal(result.loadType, "track");
    assert.equal(result.tracks.length, 1);
    const [track] = result.tracks;
    assert.equal((await manager.decodeTrack(track.track)).encoded, track.track);
    const player = manager.create({ guildId: "321", volume: 0 });
    player.queue.add(track);
    await player.play();
    await player.pause(true);
    await player.setVolume(45);
    await player.filters.setEqualizer([{ band: 0, gain: 0.1 }]);
    const [remote] = await node.rest.getAllPlayers();
    assert.equal(remote.guildId, "321");
    assert.equal(remote.paused, true);
    assert.equal(remote.volume, 45);
    assert.equal(remote.track.userData.pulsifyPlaybackId, player.playbackId);
    assert.equal(remote.filters.equalizer[0].gain, 0.1);
    const resumed = waitReady();
    node.socket.terminate();
    assert.strictEqual((await resumed)[0], node);
    assert.equal(node.sessionId, session);
    assert.equal((await node.rest.getAllPlayers())[0].track.userData.pulsifyPlaybackId, player.playbackId);
    await player.stop();
    assert.equal((await node.rest.getAllPlayers())[0].track, null);
    await player.destroy(false);
    assert.deepEqual(await node.rest.getAllPlayers(), []);
    assert.deepEqual(errors, []);
    console.log("Live Lavalink " + node.info.version.semver + " passed HTTP load, decode, play, pause, filter, resume, stop and delete.");
  } finally {
    await manager.handleShutdown();
    audio.closeAllConnections();
    await new Promise(resolve => audio.close(resolve));
    await rm(sessionDataPath, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
