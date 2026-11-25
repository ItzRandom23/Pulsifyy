# Usage reference

Start with [getting started](getting-started.md) for a complete runnable bot. Public types and option definitions are in [dist/index.d.ts](../dist/index.d.ts).

## Nodes and sources

Each node accepts `identifier`, `host`, `port`, `password`, and `useSSL`. The host contains only the hostname or IP, without a URL scheme. Use `useSSL: true` for a TLS endpoint. Lavalink passwords must match the server configuration.

```js
const { SearchPlatform } = require("pulsifyy");
// Set this in Manager options:
// defaultSearchPlatform: SearchPlatform.SoundCloud
const result = await manager.search("song name", requester, ["soundcloud"]);
const player = manager.players.get(guildId);
```

Use the exported `SearchPlatform` values to select a search provider. Call `player.search(...)` to search on that player's assigned node. Availability and playback depend on the sources and plugins enabled on your Lavalink server. Pulsifyy forwards direct HTTP(S) links to Lavalink. [Supported sources and plugin setup](../README.md#supported-sources)

## Player controls

Run controls inside your command handler and catch rejected promises. Check that the player and current track exist before using playback controls.

```js
await player.pause(true);
await player.pause(false);
await player.setVolume(50);
await player.seek(30_000); // milliseconds; track must support seeking
await player.stop();      // skip current track
await player.destroy();   // disconnect and remove player
```

`queue.current` is the current track. `queue.length` counts upcoming tracks; `queue.totalSize` includes the current track. `queue.clear()` removes upcoming tracks and does not stop the current one. To leave and remove the player, use `destroy()`.

```js
player.setTrackRepeat(true);
player.setQueueRepeat(true); // select the desired repeat mode
player.setAutoplay(true, client.user, 3);
player.setAutoplay(false);
```

Autoplay requires available recommendation sources. Configure `autoPlaySearchPlatforms` with values from the exported `AutoPlayPlatform` enum and enable corresponding sources on Lavalink.

Filters and presets require the corresponding effects to be enabled on your Lavalink node. `await player.filters.clearFilters()` resets all effects and restores the volume from before the loud preset if it is active. Stock Lavalink v4 provides no reverb effect. `setReverb()` rejects non-null settings, and the vaporwave and demon presets apply their supported effects.

## Events

| Event | Listener arguments | Purpose |
| --- | --- | --- |
| `nodeConnect` | `node` | Node connection established |
| `nodeError` | `node, error` | Node connection or message failure |
| `trackStart` | `player, track, payload` | Playback started |
| `trackEnd` | `player, track, payload` | Track ended |
| `trackError` | `player, track, payload` | Track exception |
| `queueEnd` | `player, track, payload` | Queue exhausted |

Event emitters do not await promises returned by your listeners. Catch errors inside asynchronous listeners, including Discord message sends.


## Configuration

| Options | Behavior |
| --- | --- |
| `nodes`, `send` | Declare Lavalink nodes and route Discord gateway packets to the guild's shard. Each node needs a password. |
| `useNode`, `enablePriorityMode`, `nodePriority` | Select by least players, least CPU load, or weighted node priority. |
| `apiRequestTimeoutMs` | Node request and handshake timeout. Default 10,000 ms. |
| `maxRetryAttempts`, `retryDelayMs` | Up to 10 reconnects by default, starting at 1,000 ms and backing off to 60 seconds. |
| `trackCacheMaxEntries`, `trackCacheTtlMs` | Up to 128 small track/search results for 300,000 ms by default. Set either to 0 to disable caching. |
| `maxQueueSize`, `maxPreviousTracks` | Defaults to 10,000 current and upcoming tracks per guild and 20 previous tracks. |
| `playerInactivityTimeoutMs` | Clears idle players after 300,000 ms by default. Set to 0 to disable. |
| `trackRetryAttempts`, `trackErrorRecovery` | Retry a track that fails to load twice by default. A callback can recover an exception or stuck track by replacing playback and returning true. |
| `trackPartial` | Keep the configured track fields. Pulsifyy always keeps the encoded track. |
| `lastFmApiKey`, `autoPlaySearchPlatforms` | Configure optional recommendations. Sources and plugins must be available on the node. |

Use `manager.get`, `manager.destroy`, `manager.createNode`, and `manager.destroyNode` to look up or manage live objects. `Manager.decodeTrack(s)` returns decoded Lavalink metadata. `manager.loadPlaylistInChunks` yields between batches while preparing the list and appends all tracks together once the queue has room for them. Connect only after `nodeConnect` and await controls that change remote state. Use `player.previous()`, `restart()`, `stop(amount)`, and the filter API in addition to the basic commands above.

## Session recovery

Set `enableSessionResumeOption` on the node. `sessionTimeoutMs` defaults to 60,000 ms. During a reconnect, Pulsifyy first attempts to resume on the same node. When the previous session survives, current playback stays in place. For a fresh session, Pulsifyy can reapply in-memory state or reconstruct recent saved players and request fresh voice connections. If reconnects are exhausted, Pulsifyy tries other ready nodes and disposes players it could not move.

Call `await manager.handleShutdown()` before exiting. Configure bot or cluster-specific persistence with `sessionDataPath` and a stable `manager.init(clientId, clusterId)`. The default data root is `pulsify/`, or existing `magmastream/` if there is no `pulsify/` directory. New files are scoped by bot and cluster. A legacy player file can migrate when Lavalink confirms the session and guild. Treat old snapshots as sensitive.

## Additional events

| Event | Arguments |
| --- | --- |
| `nodeCreate`, `nodeDestroy`, `nodeReconnect` | `node` |
| `nodeDisconnect` | `node, { code, reason }` |
| `nodeRaw`, `debug` | `payload` or `message` |
| `playerCreate`, `playerDestroy` | `player` |
| `playerStateUpdate` | `oldPlayer, newPlayer, change` |
| `playerMove` | `player, oldChannelId, newChannelId` |
| `playerDisconnect` | `player, oldChannelId` |
| `trackStuck` | `player, track, payload` |
| `socketClosed` | `player, payload` |
| `segmentsLoaded`, `segmentSkipped`, `chapterStarted`, `chaptersLoaded` | `player, track, payload` |
