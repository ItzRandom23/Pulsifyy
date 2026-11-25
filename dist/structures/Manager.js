"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManagerEventTypes = exports.PlayerStateEventTypes = exports.AutoPlayPlatform = exports.SearchPlatform = exports.UseNodeOptions = exports.TrackPartial = exports.Manager = void 0;
const tslib_1 = require("tslib");
const Utils_1 = require("./Utils");
const collection_1 = require("@discordjs/collection");
const events_1 = require("events");
const { Plugin } = require("./Plugin");
const managerCheck_1 = tslib_1.__importDefault(require("../utils/managerCheck"));
const promises_1 = tslib_1.__importDefault(require("fs/promises"));
const path_1 = tslib_1.__importDefault(require("path"));
const { randomUUID } = require("node:crypto");
const { scopePath, dataRoot } = require("../utils/sessionData");
const removedSearchSources = new Set(["amazonmusic", "amazon-music", "amzsearch", "qobuz", "qbsearch"]);
/**
 * The main hub for interacting with Lavalink and using Pulsifyy,
 */
class Manager extends events_1.EventEmitter {
    shutdownTask;
    inactivityTimer;
    /** The map of players. */
    players = new collection_1.Collection();
    /** The map of nodes. */
    nodes = new collection_1.Collection();
    /** Temporary reservations used while moving players after a node failure. */
    failoverReservations = new Map();
    /** In-memory cache for track and recommendation load requests. */
    trackCache = new Map();
    /** The options that were set. */
    options;
    initiated = false;
    /**
     * Initiates the Manager class.
     * @param options
     * @param options.enabledPlugins - An array of enabledPlugins to load.
     * @param options.nodes - An array of node options to create nodes from.
     * @param options.playNextOnEnd - Whether to automatically play the first track in the queue when the player is created.
     * @param options.autoPlaySearchPlatforms - The recommendation sources autoplay will use in order.
     * @param options.enablePriorityMode - Whether to use the priority when selecting a node to play on.
     * @param options.clientName - The name of the client to send to Lavalink.
     * @param options.defaultSearchPlatform - The default search platform to use when searching for tracks.
     * @param options.useNode - The strategy to use when selecting a node to play on.
     * @param options.trackPartial - The partial track search results to use when searching for tracks. This partials will always be presented on each track.
     * @param options.eventBatchDuration - The duration to wait before processing the collected player state events.
     * @param options.eventBatchInterval - The interval to wait before processing the collected player state events.
     */
    constructor(options) {
        super();
        (0, managerCheck_1.default)(options);
        Utils_1.Structure.get("Player").init(this);
        Utils_1.Structure.get("Node").init(this);
        Utils_1.AutoPlayUtils.init(this);
        const { lastFmApiKey, ...settings } = options;
        this.options = {
            ...settings,
            enabledPlugins: options.enabledPlugins ?? [],
            playNextOnEnd: options.playNextOnEnd ?? true,
            enablePriorityMode: options.enablePriorityMode ?? false,
            clientName: options.clientName ?? "Pulsifyy",
            defaultSearchPlatform: options.defaultSearchPlatform ?? SearchPlatform.Deezer,
            autoPlaySearchPlatforms: options.autoPlaySearchPlatforms ?? [AutoPlayPlatform.Spotify, AutoPlayPlatform.Deezer, AutoPlayPlatform.Jiosaavn],
            useNode: options.useNode ?? UseNodeOptions.LeastPlayers,
            maxPreviousTracks: options.maxPreviousTracks ?? 20,
            playerInactivityTimeoutMs: options.playerInactivityTimeoutMs ?? 300000,
            trackCacheTtlMs: options.trackCacheTtlMs ?? 300000,
            trackCacheMaxEntries: options.trackCacheMaxEntries ?? 128,
            maxQueueSize: options.maxQueueSize ?? 10000,
            trackRetryAttempts: options.trackRetryAttempts ?? 2,
            logLevel: options.logLevel ?? "info",
        };
        Object.defineProperty(this.options, "lastFmApiKey", { value: lastFmApiKey, writable: true });
        this.options.nodes = (options.nodes ?? []).map(nodeOptions => this.createNode(nodeOptions).options);
    }

    watchInactivePlayers() {
        const timeout = this.options.playerInactivityTimeoutMs;
        if (!timeout || this.inactivityTimer) return;
        this.inactivityTimer = setInterval(() => {
            const now = Date.now();
            for (const player of this.players.values()) {
                if (!player.destroyRequested && !player.playing && !player.paused &&
                    now - player.lastActivityAt >= timeout) {
                    player.destroy().catch(error => player.node.error(error));
                }
            }
        }, Math.min(Math.max(1000, timeout / 2), 30000));
        this.inactivityTimer.unref();
    }

    stopWatchingIdlePlayers() {
        if (this.players.size) return;
        clearInterval(this.inactivityTimer);
        this.inactivityTimer = undefined;
    }

    log(level, message, ...args) {
        const levels = { error: 0, warn: 1, info: 2, debug: 3 };
        const configured = levels[this.options?.logLevel] ?? levels.info;
        if ((levels[level] ?? levels.info) <= configured)
            console[level === "debug" ? "debug" : level](message, ...args);
    }
    /**
     * Initiates the Manager.
     * @param clientId - The Discord client ID (required).
     * @param clusterId - The cluster ID which runs the current process (required).
     * @returns The manager instance.
     */
    init(clientId, clusterId = 0) {
        if (this.shutdownTask) throw new Error("This manager has shut down.");
        if (this.initiated) {
            return this;
        }
        if (typeof clientId !== "string" || !/^\d+$/.test(clientId)) {
            throw new Error('"clientId" must be a valid Discord client ID.');
        }
        this.options.clientId = clientId;
        if (!Number.isSafeInteger(clusterId) || clusterId < 0) {
            console.warn('"clusterId" is not a valid number, defaulting to 0.');
            clusterId = 0;
        }
        this.options.clusterId = clusterId;
        const plugins = this.options.enabledPlugins ?? [];
        for (const [index, plugin] of plugins.entries()) {
            if (!(plugin instanceof Plugin)) throw new TypeError("Invalid plugin at index " + index);
        }
        for (const plugin of plugins) plugin.load(this);
        this.initiated = true;
        for (const node of this.nodes.values()) {
            try { node.connect(); } catch (error) { this.emit(ManagerEventTypes.NodeError, node, error); }
        }
        return this;
    }
    /**
     * Searches the enabled sources based off the URL or the `source` property.
     * @param query
     * @param requester
     * @param sourcePlatforms
     * @returns The search result.
     */

    async search(query, requester, sourcePlatforms) {
        return this.searchOnNode(this.useableNode, query, requester, sourcePlatforms);
    }

    async searchOnNode(node, query, requester, sourcePlatforms) {
        if (!node?.connected) throw new Error("No available nodes.");
        const _query = typeof query === "string" ? { query } : query;
        if (typeof _query?.query !== "string" || !_query.query.trim() || _query.query.length > 4096) {
            throw new TypeError("Search query must be a non-empty string of at most 4096 characters.");
        }
        const value = _query.query.trim();

        let identifiers;
        if (/^https?:\/\//i.test(value)) {
            new URL(value);
            identifiers = [value];
        } else {
            const platforms = Array.isArray(sourcePlatforms)
                ? sourcePlatforms
                : [sourcePlatforms ?? _query.source ?? this.options.defaultSearchPlatform];
            identifiers = [];
            for (const platform of platforms) {
                if (typeof platform !== "string") continue;
                const name = platform.trim().toLowerCase();
                if (removedSearchSources.has(name)) continue;
                const prefix = searchPlatformAliases.get(name) ?? platform.trim();
                if (/^[a-z0-9-]+$/i.test(prefix)) identifiers.push(prefix + ":" + value);
            }
        }
        let failure;
        let empty = !identifiers.length;
        for (const identifier of identifiers) {
            try {
                const res = await node.rest.get("/v4/loadtracks?identifier=" + encodeURIComponent(identifier));
                if (res?.loadType === Utils_1.LoadTypes.Empty) {
                    empty = true;
                    continue;
                }
                let tracks = [];
                let playlist = null;

                switch (res.loadType) {
                    case Utils_1.LoadTypes.Search:
                        tracks = res.data.map((track) => Utils_1.TrackUtils.build(track, requester, this.options.trackPartial ?? null));
                        break;
                    case Utils_1.LoadTypes.Track:
                        tracks = [Utils_1.TrackUtils.build(res.data, requester, this.options.trackPartial ?? null)];
                        break;
                    case Utils_1.LoadTypes.Playlist:
                        const playlistData = res.data;
                        tracks = playlistData.tracks.map((track) => Utils_1.TrackUtils.build(track, requester, this.options.trackPartial ?? null));
                        playlist = {
                            name: playlistData.info.name,
                            playlistInfo: playlistData.pluginInfo,
                            requester: requester,
                            tracks,
                            duration: tracks.reduce((acc, cur) => acc + (cur.duration || 0), 0),
                        };
                        break;
                    default:
                        throw new Error("Lavalink could not load the requested tracks.");
                }
                return { loadType: res.loadType, tracks, playlist };
            } catch (error) {
                failure = error;
            }
        }
        if (failure && !empty) throw failure;
        return {
            loadType: Utils_1.LoadTypes.Empty,
            tracks: [],
            playlist: null
        };

    }

    /**
     * Creates a player or returns one if it already exists.
     * @param options The options to create the player with.
     * @returns The created player.
     */
    create(options) {
        if (!options || typeof options !== "object") throw new TypeError("Player options are required.");
        if (this.players.has(options.guildId)) {
            return this.players.get(options.guildId);
        }
        if (this.shutdownTask) throw new Error("This manager has shut down.");
        return Utils_1.Structure.create("Player", options, this);
    }
    /** Loads a playlist and appends it to a player in event-loop-friendly chunks. */
    async loadPlaylistInChunks(player, query, requester, sourcePlatforms, chunkSize = 100) {
        if (!player || this.players.get(player.guildId) !== player || player.destroyRequested)
            throw new TypeError("A valid player is required.");
        if (!Number.isInteger(chunkSize) || chunkSize < 1)
            throw new RangeError("chunkSize must be a positive integer.");
        const result = await this.search(query, requester, sourcePlatforms);
        const tracks = result.playlist?.tracks ?? result.tracks ?? [];
        if (tracks.length > this.options.maxQueueSize) throw new RangeError("Queue limit exceeded.");
        const prepared = [];
        for (let index = 0; index < tracks.length; index += chunkSize) {
            const chunk = tracks.slice(index, index + chunkSize);
            if (!Utils_1.TrackUtils.validate(chunk)) throw new TypeError("Invalid queue track.");
            for (const track of chunk) prepared.push(track);
            if (index + chunkSize < tracks.length) await new Promise(resolve => setImmediate(resolve));
        }
        if (player.destroyRequested) throw new Error("Player was destroyed.");
        // Queue.add checks the final capacity and appends the whole playlist in a single turn.
        player.queue.add(prepared);
        return result;
    }
    /**
     * Returns a player or undefined if it does not exist.
     * @param guildId The guild ID of the player to retrieve.
     * @returns The player if it exists, undefined otherwise.
     */
    get(guildId) {
        return this.players.get(guildId);
    }
    /**
     * Destroys a player.
     * @param guildId The guild ID of the player to destroy.
     * @returns A promise that resolves when the player has been destroyed.
     */
    async destroy(guildId) {
        // Emit debug message for player destruction
        this.emit(ManagerEventTypes.Debug, `[MANAGER] Destroying player: ${guildId}`);
        const player = this.players.get(guildId);
        if (player) {
            await player.destroy();
        }

    }
    /**
     * Creates a new node or returns an existing one if it already exists.
     * @param options - The options to create the node with.
     * @returns The created node.
     */
    createNode(options) {
        if (!options || typeof options !== "object") throw new TypeError("Node options are required.");
        // Check if the node already exists in the manager's collection
        if (this.nodes.has(options.identifier || options.host)) {
            // Return the existing node if it does
            return this.nodes.get(options.identifier || options.host);
        }
        if (this.shutdownTask) throw new Error("This manager has shut down.");
        const node = Utils_1.Structure.create("Node", options, this);
        if (this.initiated) node.connect();
        return node;
    }
    /**
     * Destroys a node if it exists. Emits a debug event if the node is found and destroyed.
     * @param identifier - The identifier of the node to destroy.
     * @returns {void}
     * @emits {debug} - Emits a debug message indicating the node is being destroyed.
     */
    async destroyNode(identifier) {
        const node = this.nodes.get(identifier);
        if (!node)
            return;
        this.emit(ManagerEventTypes.Debug, `[MANAGER] Destroying node: ${identifier}`);
        await node.destroy();
    }
    /**
     * Attaches an event listener to the manager.
     * @param event The event to listen for.
     * @param listener The function to call when the event is emitted.
     * @returns The manager instance for chaining.
     */
    on(event, listener) {
        return super.on(event, listener);
    }
    /**
     * Updates the voice state of a player based on the provided data.
     * @param data - The data containing voice state information, which can be a VoicePacket, VoiceServer, or VoiceState.
     * @returns A promise that resolves when the voice state update is handled.
     * @emits {debug} - Emits a debug message indicating the voice state is being updated.
     */
    async updateVoiceState(data) {
        if (!data || typeof data !== "object" || this.shutdownTask) return;
        if ("t" in data && data.t !== "VOICE_STATE_UPDATE" && data.t !== "VOICE_SERVER_UPDATE") return;
        const update = "t" in data ? data.d : data;
        if (!update || typeof update.guild_id !== "string") return;
        const player = this.players.get(update.guild_id);
        if (!player || player.destroyRequested) return;
        const voice = player.voiceState;

        if (typeof update.token === "string" && (update.endpoint === null || typeof update.endpoint === "string")) {
            if (voice.event?.token !== update.token || voice.event?.endpoint !== update.endpoint) {
                voice.event = { token: update.token, endpoint: update.endpoint };
            }
            if (!update.endpoint) voice.sent = undefined;
            else if (voice.awaitingServer && voice.channelId === player.voiceChannelId) {
                voice.boundEvent = voice.event;
                voice.awaitingServer = false;
            }
        } else {
            if (!this.options.clientId || update.user_id !== this.options.clientId) return;
            if (update.channel_id === null) {
                this.emit(ManagerEventTypes.PlayerDisconnect, player, player.voiceChannelId);
                await player.destroy(false);
                return;
            }
            if (typeof update.channel_id !== "string" || typeof update.session_id !== "string" || !update.session_id) return;
            const previous = player.voiceChannelId;
            const current = update.channel_id;
            // An unchanged state for the old channel can arrive before Discord confirms a local move.
            if (player.pendingVoiceJoin?.channelId === previous && previous !== current &&
                voice.channelId === current && voice.sessionId === update.session_id) return;
            if (voice.channelId !== current || voice.sessionId !== update.session_id) {
                // A server packet can arrive first, including when a moderator moves the bot.
                // Keep credentials not yet paired with a gateway state even if they were sent earlier.
                if (voice.event?.endpoint && voice.event !== voice.boundEvent) {
                    voice.boundEvent = voice.event;
                    voice.awaitingServer = false;
                } else {
                    voice.event = undefined;
                    voice.awaitingServer = true;
                }
            }
            player.voiceChannelId = current;
            voice.channelId = current;
            voice.sessionId = update.session_id;
            if (previous !== current) this.emit(ManagerEventTypes.PlayerMove, player, previous, current);
        }
        return this.sendVoiceUpdate(player);
    }

    async sendVoiceUpdate(player) {
        if (!player.node.sessionId || player.destroyRequested || !player.voiceState.event?.endpoint ||
            !player.voiceState.sessionId || !player.voiceState.channelId) return;
        return player.runOperation(async () => {
            const { event, sessionId, channelId, sent } = player.voiceState;
            const nodeSession = player.node.sessionId;
            if (!nodeSession || !event?.token || !event.endpoint || !sessionId || !channelId || channelId !== player.voiceChannelId) return;
            if (sent?.token === event.token && sent.endpoint === event.endpoint &&
                sent.sessionId === sessionId && sent.channelId === channelId && sent.node === player.node &&
                sent.nodeSession === nodeSession) return;
            await player.node.rest.updatePlayer({
                guildId: player.guildId, data: { voice: { token: event.token, endpoint: event.endpoint, sessionId, channelId } },
            });
            player.voiceState.sent = { ...event, event, sessionId, channelId, node: player.node, nodeSession };
            if (player.voiceState.event === event && player.voiceState.sessionId === sessionId) {
                player.markVoiceConnected(channelId);
            }
        });
    }

    /**
     * Decodes an array of base64 encoded tracks and returns an array of TrackData.
     * Emits a debug event with the tracks being decoded.
     * @param tracks - An array of base64 encoded track strings.
     * @returns A promise that resolves to an array of TrackData objects.
     * @throws Will throw an error if no nodes are available or if the API request fails.
     */
    decodeTracks(tracks) {
        if (!Array.isArray(tracks) || !tracks.every(track => typeof track === "string" && track)) return Promise.reject(new TypeError("Expected encoded tracks."));
        const node = this.useableNode;
        if (!node)
            return Promise.reject(new Error("No available nodes."));
        return node.rest.post("/v4/decodetracks", tracks).then((res) => {
            if (!Array.isArray(res))
                throw new Error("Invalid Lavalink track decode response.");
            return res;
        });
    }
    /**
     * Decodes a base64 encoded track and returns a TrackData.
     * @param track - The base64 encoded track string.
     * @returns A promise that resolves to a TrackData object.
     * @throws Will throw an error if no nodes are available or if the API request fails.
     */
    async decodeTrack(track) {
        const res = await this.decodeTracks([track]);
        // Since we're only decoding one track, we can just return the first element of the array
        return res[0];
    }
    /**
     * Saves player states to the JSON file.
     * @param {string} guildId - The guild ID of the player to save
     */
    async savePlayerState(guildId) {
        const player = this.players.get(guildId);
        if (player) await this.persistPlayerState(player);
    }

    async persistPlayerState(player, duringShutdown = false) {
        if (!player.voiceChannelId || (player.destroyRequested && !duringShutdown)) return;
        const { guildId } = player;
        const file = await this.getPlayerFilePath(guildId);
        const temporary = file + "." + randomUUID() + ".tmp";
        try {
            await promises_1.default.writeFile(temporary, JSON.stringify(this.serializePlayer(player)), { flag: "wx", mode: 0o600 });
            if (this.players.get(guildId) === player && (duringShutdown || !player.destroyRequested)) {
                await promises_1.default.rename(temporary, file);
            }
        } finally {
            await promises_1.default.rm(temporary, { force: true });
        }
    }

    async loadPlayerStates(nodeId, resumed = true) {
        const node = this.nodes.get(nodeId);
        if (!node) throw new Error("Unknown Lavalink node.");
        const directory = path_1.default.join(scopePath(this), "players");
        const legacy = path_1.default.join(dataRoot, "dist", "sessionData", "players");
        let players;
        if (resumed) {
            players = await node.rest.getAllPlayers();
            if (!Array.isArray(players)) throw new Error("Invalid Lavalink player response.");
        } else {
            let files;
            try { files = await promises_1.default.readdir(directory, { withFileTypes: true }); }
            catch (error) { if (error.code === "ENOENT") return; throw error; }
            players = files.filter(file => file.isFile() && /^\d+\.json$/.test(file.name))
                .map(file => ({ guildId: file.name.slice(0, -5) }));
        }
        for (const remote of players) {
            const guildId = remote?.guildId;
            if (typeof guildId !== "string" || !/^\d+$/.test(guildId) || this.shutdownTask) continue;
            const existing = this.players.get(guildId);
            if (existing) {
                if (resumed && existing.node === node && !remote.track && existing.queue.current &&
                    (existing.playbackId || existing.playing || existing.paused)) {
                    existing.pendingResumedEnd = { track: existing.queue.current, playbackId: existing.playbackId };
                }
                continue;
            }
            let snapshot;
            try {
                snapshot = await this.readPlayerSnapshot(guildId, node, directory, legacy, resumed);
            } catch {
                node.error(new Error("A saved Lavalink player could not be read."));
            }
            if (this.shutdownTask || this.players.has(guildId) || this.nodes.get(nodeId) !== node) continue;
            const state = snapshot?.state;
            if (!state && !resumed) continue;

            try {
                const savedTrack = state?.queue?.current;
                const savedPlaybackId = typeof state?.playbackId === "string" ? state.playbackId : undefined;
                const remotePlaybackId = typeof remote.track?.userData?.pulsifyPlaybackId === "string"
                    ? remote.track.userData.pulsifyPlaybackId : undefined;
                const samePlayback = savedPlaybackId && remotePlaybackId
                    ? savedPlaybackId === remotePlaybackId
                    : savedTrack?.track === remote.track?.encoded ||
                        (savedTrack?.identifier && savedTrack.identifier === remote.track?.info?.identifier &&
                            savedTrack.sourceName?.toLowerCase() === remote.track?.info?.sourceName?.toLowerCase());
                const current = remote.track
                    ? Utils_1.TrackUtils.build(remote.track, samePlayback ? savedTrack?.requester : undefined, this.options.trackPartial ?? null)
                    : this.restoreSnapshotTrack(savedTrack);
                const channel = remote.voice?.channelId ?? state?.voiceChannelId ?? state?.options?.voiceChannelId;
                const voiceChannelId = typeof channel === "string" && /^\d+$/.test(channel) ? channel : undefined;
                const volume = Number.isInteger(remote.volume) && remote.volume >= 0 && remote.volume <= 1000
                    ? remote.volume : state?.options?.volume;
                const player = this.create({ ...state?.options, guildId, node: nodeId, voiceChannelId, volume });
                player.position = (resumed ? remote.state?.position : state.position) ?? 0;
                player.paused = !!(resumed ? remote.track && remote.paused : state.paused);
                player.playing = !!(resumed ? remote.track && !player.paused : state.playing);
                player.queue.current = current;
                player.playbackId = remote.track ? remotePlaybackId : resumed ? savedPlaybackId : undefined;
                if (resumed && !remote.track && current && (state?.playing || state?.paused || savedPlaybackId)) {
                    player.pendingResumedEnd = { track: current, playbackId: savedPlaybackId };
                }
                const voice = remote.voice;
                if (voiceChannelId && voice?.token && voice.endpoint && voice.sessionId) {
                    const event = { token: voice.token, endpoint: voice.endpoint };
                    Object.assign(player.voiceState, { event, boundEvent: event, channelId: voiceChannelId, sessionId: voice.sessionId,
                        sent: { ...event, event, channelId: voiceChannelId, sessionId: voice.sessionId, node, nodeSession: node.sessionId } });
                }
                const upcoming = state?.queue?.tracks;
                if (Array.isArray(upcoming)) {
                    player.queue.add(upcoming.map(track => this.restoreSnapshotTrack(track)).filter(Boolean)
                        .slice(0, this.options.maxQueueSize - player.queue.totalSize));
                }
                if (Array.isArray(state?.queue?.previous)) {
                    player.queue.previous = state.queue.previous.map(track => this.restoreSnapshotTrack(track))
                        .filter(Boolean).slice(-this.options.maxPreviousTracks);
                }
                if (state?.trackRepeat) player.setTrackRepeat(true);
                else if (state?.queueRepeat) player.setQueueRepeat(true);
                else if (state?.dynamicRepeat && state.dynamicRepeatIntervalMs && player.queue.totalSize > 0) player.setDynamicRepeat(true, state.dynamicRepeatIntervalMs);
                if (state?.isAutoplay && state.data?.clientUser?.id) player.setAutoplay(true, state.data.clientUser, state.autoplayTries);
                if (state?.filters) player.filters.restore(state.filters);
                if (resumed && voiceChannelId) player.markVoiceConnected(voiceChannelId);
                if (snapshot?.migrated) {
                    await this.savePlayerState(guildId);
                    await promises_1.default.unlink(snapshot.file);
                }
            } catch {
                node.error(new Error("A Lavalink player could not be restored."));
            }
        }
    }

    async readPlayerSnapshot(guildId, node, directory, legacy, resumed) {
        let file = path_1.default.join(directory, guildId + ".json");
        let migrated = false;
        let serialized;
        try { serialized = await promises_1.default.readFile(file, "utf8"); }
        catch (error) {
            if (error.code !== "ENOENT") throw error;
            if (this.options.sessionDataPath || !resumed) return;
            file = path_1.default.join(legacy, guildId + ".json");
            migrated = true;
            try { serialized = await promises_1.default.readFile(file, "utf8"); }
            catch (legacyError) { if (legacyError.code === "ENOENT") return; throw legacyError; }
        }
        const state = JSON.parse(serialized);
        if (state?.guildId !== guildId || (state.nodeId ?? state.node?.options?.identifier) !== node.options.identifier) return;
        if (Number.isFinite(state.savedAt) && Date.now() - state.savedAt > node.options.sessionTimeoutMs) {
            await promises_1.default.rm(file, { force: true });
            return;
        }
        if (!resumed && !Number.isFinite(state.savedAt)) return;
        return { state, file, migrated };
    }

    restoreSnapshotTrack(track) {
        if (!Utils_1.TrackUtils.validate(track)) return null;
        const { track: encoded, duration: length, requester, ...info } = track;
        return Utils_1.TrackUtils.build({ encoded, info: { ...info, length }, pluginInfo: {} }, requester, this.options.trackPartial ?? null);
    }

    scheduleResumedEnds(node) {
        const pending = [...this.players.values()].filter(player => player.node === node && player.pendingResumedEnd);
        if (!pending.length) return;
        // Let Lavalink replay buffered events after ready before reconciling an idle remote player.
        const socket = node.socket;
        const timer = setTimeout(() => {
            if (this.shutdownTask || node.socket !== socket || !node.connected) return;
            for (const player of pending) {
                const end = player.pendingResumedEnd;
                if (!end) continue;
                player.pendingResumedEnd = undefined;
                if (player.destroyRequested || player.node !== node ||
                    player.playbackId !== end.playbackId || player.queue.current !== end.track) continue;
                const track = end.track;
                node.handleEvent({
                    op: "event", guildId: player.guildId, type: "TrackEndEvent", reason: "finished",
                    track: { encoded: track.track, info: { identifier: track.identifier, title: track.title,
                        length: track.duration, sourceName: track.sourceName }, pluginInfo: {},
                        userData: end.playbackId ? { pulsifyPlaybackId: end.playbackId } : {} },
                }).catch(error => node.error(error));
            }
        }, 1000);
        timer.unref();
        return timer;
    }

    /**
     * Returns the node to use based on the configured `useNode` and `enablePriorityMode` options.
     * If `enablePriorityMode` is true, the node is chosen based on priority, otherwise it is chosen based on the `useNode` option.
     * If `useNode` is "leastLoad", the node with the lowest load is chosen, if it is "leastPlayers", the node with the fewest players is chosen.
     * If `enablePriorityMode` is false and `useNode` is not set, the node with the lowest load is chosen.
     * @returns {Node} The node to use.
     */
    get useableNode() {
        return this.options.enablePriorityMode
            ? this.priorityNode
            : this.options.useNode === UseNodeOptions.LeastLoad
                ? this.leastLoadNode.first()
                : this.leastPlayersNode.first();
    }
    /**
     * Selects a failover node while accounting for migrations that have not
     * appeared in Lavalink's statistics yet. This prevents a disconnect storm
     * from assigning every player to the same node.
     */
    getFailoverNode(excludedNode, excludedTargets) {
        const connectedCandidates = this.nodes.filter((node) => node.connected && node !== excludedNode && !excludedTargets?.has(node));
        const healthyCandidates = connectedCandidates.filter((node) => this.isHealthyNode(node));
        const candidates = (healthyCandidates.length ? healthyCandidates : connectedCandidates)
            .sort((a, b) => {
            const aReservations = this.failoverReservations.get(a.options.identifier) ?? 0;
            const bReservations = this.failoverReservations.get(b.options.identifier) ?? 0;
            const aPlayers = Math.max(a.stats?.players ?? 0, a.localPlayers ?? 0) + aReservations;
            const bPlayers = Math.max(b.stats?.players ?? 0, b.localPlayers ?? 0) + bReservations;
            if (aPlayers !== bPlayers)
                return aPlayers - bPlayers;
            const aload = a.stats?.cpu?.cores ? (a.stats.cpu.lavalinkLoad / a.stats.cpu.cores) : 0;
            const bload = b.stats?.cpu?.cores ? (b.stats.cpu.lavalinkLoad / b.stats.cpu.cores) : 0;
            return aload - bload;
        });
        const node = candidates.first();
        if (node) {
            const id = node.options.identifier;
            this.failoverReservations.set(id, (this.failoverReservations.get(id) ?? 0) + 1);
        }
        return node;
    }
    isHealthyNode(node) {
        const cpu = node?.stats?.cpu;
        const memory = node?.stats?.memory;
        const cpuLoad = cpu?.cores ? cpu.lavalinkLoad / cpu.cores : 0;
        const memoryLoad = memory?.allocated ? memory.used / memory.allocated : 0;
        return !!node?.connected && cpuLoad < 0.95 && memoryLoad < 0.95;
    }
    releaseFailoverReservation(node) {
        const id = node.options.identifier;
        const count = (this.failoverReservations.get(id) ?? 1) - 1;
        if (count > 0)
            this.failoverReservations.set(id, count);
        else
            this.failoverReservations.delete(id);
    }
    handleShutdown() {
        this.shutdownTask ??= Promise.resolve().then(async () => {
            clearInterval(this.inactivityTimer);
            this.inactivityTimer = undefined;
            const failures = [];
            const players = this.players.values();
            const worker = async () => {
                for (const player of players) {
                    try { await player.destroy(true, true); }
                    catch (error) { failures.push(error); }
                }
            };
            await Promise.all(Array.from({ length: Math.min(this.players.size, 8) }, worker));
            const results = await Promise.allSettled([...this.nodes.values()].map(node => node.destroy()));
            for (const result of results) if (result.status === "rejected") failures.push(result.reason);
            this.trackCache.clear();
            this.failoverReservations.clear();
            if (failures.length) throw new AggregateError(failures, "Pulsifyy could not finish shutdown cleanly.");
        });
        return this.shutdownTask;
    }

    async getPlayerFilePath(guildId) {
        if (typeof guildId !== "string" || !/^\d+$/.test(guildId)) throw new TypeError("Invalid Discord guild ID.");
        const directory = path_1.default.join(scopePath(this), "players");
        await promises_1.default.mkdir(directory, { recursive: true, mode: 0o700 });
        return path_1.default.join(directory, guildId + ".json");
    }

    async removePlayerState(guildId) {
        if (typeof guildId !== "string" || !/^\d+$/.test(guildId)) throw new TypeError("Invalid Discord guild ID.");
        if (!this.initiated) return;
        const file = path_1.default.join(scopePath(this), "players", guildId + ".json");
        await promises_1.default.rm(file, { force: true });
    }

    serializePlayer(player) {
        const safeUri = value => {
            if (typeof value !== "string") return null;
            try {
                const url = new URL(value);
                if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
                return url.href;
            } catch { return null; }
        };
        const serializeTrack = track => track && {
            track: track.track, title: track.title, identifier: track.identifier,
            author: track.author, duration: track.duration, sourceName: track.sourceName,
            isSeekable: track.isSeekable, isStream: track.isStream, isrc: track.isrc,
            uri: safeUri(track.uri), artworkUrl: safeUri(track.artworkUrl),
            requester: typeof track.requester?.id === "string" ? { id: track.requester.id } : undefined,
        };
        const bot = player.get("Internal_BotUser");
        return {
            savedAt: Date.now(), playbackId: player.queue.current ? player.playbackId : undefined,
            playing: player.playing, paused: player.paused, position: player.position, guildId: player.guildId, nodeId: player.node.options.identifier, voiceChannelId: player.voiceChannelId,
            options: {
                textChannelId: player.textChannelId, voiceChannelId: player.voiceChannelId,
                selfDeafen: player.options.selfDeafen, selfMute: player.options.selfMute, volume: player.volume,
            },
            queue: {
                current: serializeTrack(player.queue.current),
                tracks: Array.from(player.queue, serializeTrack),
                previous: player.queue.previous.map(serializeTrack).filter(Boolean),
            },
            filters: player.filters?.snapshot(),
            data: { clientUser: typeof bot?.id === "string" ? { id: bot.id } : undefined },
            trackRepeat: player.trackRepeat, queueRepeat: player.queueRepeat,
            dynamicRepeat: player.dynamicRepeat, dynamicRepeatIntervalMs: player.dynamicRepeatIntervalMs,
            isAutoplay: player.isAutoplay, autoplayTries: player.autoplayTries,
        };
    }

    get leastLoadNode() {
        return this.nodes
            .filter((node) => this.isHealthyNode(node))
            .sort((a, b) => {
            const aload = a.stats.cpu?.cores ? (a.stats.cpu.lavalinkLoad / a.stats.cpu.cores) * 100 : 0;
            const bload = b.stats.cpu?.cores ? (b.stats.cpu.lavalinkLoad / b.stats.cpu.cores) * 100 : 0;
                // Sort the nodes by their load in ascending order
                return aload - bload;
            });
    }
    /**
     * Returns the nodes that have the least amount of players.
     * Filters out disconnected nodes and sorts the remaining nodes
     * by the number of players in ascending order.
     * @returns {Collection<string, Node>} A collection of nodes sorted by player count.
     */
    get leastPlayersNode() {
        return this.nodes
            .filter((node) => this.isHealthyNode(node))
            .sort((a, b) => Math.max(a.stats.players, a.localPlayers ?? 0) - Math.max(b.stats.players, b.localPlayers ?? 0)); // Sort by the number of players
    }
    /**
     * Returns a node based on priority.
     * The nodes are sorted by priority in descending order, and then a random number
     * between 0 and 1 is generated. The node that has a cumulative weight greater than or equal to the
     * random number is returned.
     * If no node has a cumulative weight greater than or equal to the random number, the node with the
     * lowest load is returned.
     * @returns {Node} The node to use.
     */
    get priorityNode() {
        // Filter out nodes that are not connected or have a priority of 0
        const filteredNodes = this.nodes.filter((node) => this.isHealthyNode(node) && node.options.nodePriority > 0);
        // Calculate the total weight
        const totalWeight = filteredNodes.reduce((total, node) => total + node.options.nodePriority, 0);
        // Map the nodes to their weights
        const weightedNodes = filteredNodes.map((node) => ({
            node,
            weight: node.options.nodePriority / totalWeight,
        }));
        // Generate a random number between 0 and 1
        const randomNumber = Math.random();
        // Initialize the cumulative weight to 0
        let cumulativeWeight = 0;
        // Loop through the weighted nodes and find the first node that has a cumulative weight greater than or equal to the random number
        for (const { node, weight } of weightedNodes) {
            cumulativeWeight += weight;
            if (randomNumber <= cumulativeWeight) {
                return node;
            }
        }
        // If no node has a cumulative weight greater than or equal to the random number, return the node with the lowest load
        return this.options.useNode === UseNodeOptions.LeastLoad ? this.leastLoadNode.first() : this.leastPlayersNode.first();
    }
}
exports.Manager = Manager;
var TrackPartial;
(function (TrackPartial) {
    /** The base64 encoded string of the track */
    TrackPartial["Track"] = "track";
    /** The title of the track */
    TrackPartial["Title"] = "title";
    /** The track identifier */
    TrackPartial["Identifier"] = "identifier";
    /** The author of the track */
    TrackPartial["Author"] = "author";
    /** The length of the track in milliseconds */
    TrackPartial["Duration"] = "duration";
    /** The ISRC of the track */
    TrackPartial["Isrc"] = "isrc";
    /** Whether the track is seekable */
    TrackPartial["IsSeekable"] = "isSeekable";
    /** Whether the track is a stream */
    TrackPartial["IsStream"] = "isStream";
    /** The URI of the track */
    TrackPartial["Uri"] = "uri";
    /** The artwork URL of the track */
    TrackPartial["ArtworkUrl"] = "artworkUrl";
    /** The source name of the track */
    TrackPartial["SourceName"] = "sourceName";
    /** The thumbnail of the track */
    TrackPartial["ThumbNail"] = "thumbnail";
    /** The requester of the track */
    TrackPartial["Requester"] = "requester";
    /** The plugin info of the track */
    TrackPartial["PluginInfo"] = "pluginInfo";
    /** The custom data of the track */
    TrackPartial["CustomData"] = "customData";
})(TrackPartial || (exports.TrackPartial = TrackPartial = {}));
var UseNodeOptions;
(function (UseNodeOptions) {
    UseNodeOptions["LeastLoad"] = "leastLoad";
    UseNodeOptions["LeastPlayers"] = "leastPlayers";
})(UseNodeOptions || (exports.UseNodeOptions = UseNodeOptions = {}));
var SearchPlatform;
(function (SearchPlatform) {
    SearchPlatform["AppleMusic"] = "amsearch";
    SearchPlatform["AudioMack"] = "admsearch";
    SearchPlatform["Bandcamp"] = "bcsearch";
    SearchPlatform["Deezer"] = "dzsearch";
    SearchPlatform["Gaana"] = "gnsearch";
    SearchPlatform["Jiosaavn"] = "jssearch";
    SearchPlatform["SoundCloud"] = "scsearch";
    SearchPlatform["Spotify"] = "spsearch";
    SearchPlatform["Tidal"] = "tdsearch";
    SearchPlatform["VKMusic"] = "vksearch";
    SearchPlatform["YouTube"] = "ytsearch";
    SearchPlatform["YouTubeMusic"] = "ytmsearch";
})(SearchPlatform || (exports.SearchPlatform = SearchPlatform = {}));
const searchPlatformAliases = new Map(Object.entries(SearchPlatform).map(([name, prefix]) => [name.toLowerCase(), prefix]));
searchPlatformAliases.set("gasearch", SearchPlatform.Gaana);
searchPlatformAliases.set("ytmusic", SearchPlatform.YouTubeMusic);
searchPlatformAliases.set("youtube-music", SearchPlatform.YouTubeMusic);
searchPlatformAliases.set("youtube music", SearchPlatform.YouTubeMusic);
var AutoPlayPlatform;
(function (AutoPlayPlatform) {
    AutoPlayPlatform["Spotify"] = "spotify";
    AutoPlayPlatform["Deezer"] = "deezer";
    AutoPlayPlatform["Jiosaavn"] = "jiosaavn";
    AutoPlayPlatform["SoundCloud"] = "soundcloud";
    AutoPlayPlatform["Tidal"] = "tidal";
    AutoPlayPlatform["VKMusic"] = "vkmusic";
})(AutoPlayPlatform || (exports.AutoPlayPlatform = AutoPlayPlatform = {}));
var PlayerStateEventTypes;
(function (PlayerStateEventTypes) {
    PlayerStateEventTypes["AutoPlayChange"] = "playerAutoplay";
    PlayerStateEventTypes["ConnectionChange"] = "playerConnection";
    PlayerStateEventTypes["RepeatChange"] = "playerRepeat";
    PlayerStateEventTypes["PauseChange"] = "playerPause";
    PlayerStateEventTypes["QueueChange"] = "queueChange";
    PlayerStateEventTypes["TrackChange"] = "trackChange";
    PlayerStateEventTypes["VolumeChange"] = "volumeChange";
    PlayerStateEventTypes["ChannelChange"] = "channelChange";
    PlayerStateEventTypes["PlayerCreate"] = "playerCreate";
    PlayerStateEventTypes["PlayerDestroy"] = "playerDestroy";
})(PlayerStateEventTypes || (exports.PlayerStateEventTypes = PlayerStateEventTypes = {}));
var ManagerEventTypes;
(function (ManagerEventTypes) {
    ManagerEventTypes["Debug"] = "debug";
    ManagerEventTypes["NodeCreate"] = "nodeCreate";
    ManagerEventTypes["NodeDestroy"] = "nodeDestroy";
    ManagerEventTypes["NodeConnect"] = "nodeConnect";
    ManagerEventTypes["NodeReconnect"] = "nodeReconnect";
    ManagerEventTypes["NodeDisconnect"] = "nodeDisconnect";
    ManagerEventTypes["NodeError"] = "nodeError";
    ManagerEventTypes["NodeRaw"] = "nodeRaw";
    ManagerEventTypes["PlayerCreate"] = "playerCreate";
    ManagerEventTypes["PlayerDestroy"] = "playerDestroy";
    ManagerEventTypes["PlayerStateUpdate"] = "playerStateUpdate";
    ManagerEventTypes["PlayerMove"] = "playerMove";
    ManagerEventTypes["PlayerDisconnect"] = "playerDisconnect";
    ManagerEventTypes["QueueEnd"] = "queueEnd";
    ManagerEventTypes["SocketClosed"] = "socketClosed";
    ManagerEventTypes["TrackStart"] = "trackStart";
    ManagerEventTypes["TrackEnd"] = "trackEnd";
    ManagerEventTypes["TrackStuck"] = "trackStuck";
    ManagerEventTypes["TrackError"] = "trackError";
    ManagerEventTypes["SegmentsLoaded"] = "segmentsLoaded";
    ManagerEventTypes["SegmentSkipped"] = "segmentSkipped";
    ManagerEventTypes["ChapterStarted"] = "chapterStarted";
    ManagerEventTypes["ChaptersLoaded"] = "chaptersLoaded";
})(ManagerEventTypes || (exports.ManagerEventTypes = ManagerEventTypes = {}));
