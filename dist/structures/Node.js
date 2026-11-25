"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Node = exports.SponsorBlockSegment = void 0;
const tslib_1 = require("tslib");
const Utils_1 = require("./Utils");
const Manager_1 = require("./Manager");
const Rest_1 = require("./Rest");
const nodeCheck_1 = require("../utils/nodeCheck");
const ws_1 = tslib_1.__importDefault(require("ws"));
const fs_1 = tslib_1.__importDefault(require("fs"));
const path_1 = tslib_1.__importDefault(require("path"));
var SponsorBlockSegment;
(function (SponsorBlockSegment) {
    SponsorBlockSegment["Sponsor"] = "sponsor";
    SponsorBlockSegment["SelfPromo"] = "selfpromo";
    SponsorBlockSegment["Interaction"] = "interaction";
    SponsorBlockSegment["Intro"] = "intro";
    SponsorBlockSegment["Outro"] = "outro";
    SponsorBlockSegment["Preview"] = "preview";
    SponsorBlockSegment["MusicOfftopic"] = "music_offtopic";
    SponsorBlockSegment["Filler"] = "filler";
})(SponsorBlockSegment || (exports.SponsorBlockSegment = SponsorBlockSegment = {}));
const validSponsorBlocks = Object.values(SponsorBlockSegment).map((v) => v.toLowerCase());
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { inspect } = require("node:util");
const { scopePath } = require("../utils/sessionData");
function getEventTrackKey(eventTrack) {
    if (typeof eventTrack === "string")
        return eventTrack;
    if (!eventTrack || typeof eventTrack !== "object")
        return null;
    if (typeof eventTrack.encoded === "string")
        return eventTrack.encoded;
    if (typeof eventTrack.track?.encoded === "string")
        return eventTrack.track.encoded;
    return null;
}
class Node {
    options;
    /** The socket for the node. */
    socket = null;
    /** The stats for the node. */
    stats;
    /** The manager for the node */
    manager;
    /** The node's session ID. */
    sessionId;
    /** The REST instance. */
    rest;
    /** Actual Lavalink information of the node. */
    info = null;
    static managerRef;
    reconnectTimeout;
    reconnecting = false;
    destroyed = false;
    reconnectAttempts = 0;
    ready = false;
    sessionInvalidated = false;
    /**
     * Creates an instance of Node.
     * @param options
     */
    constructor(options, manager = Utils_1.Structure.constructingManager ?? new.target.managerRef?.deref()) {
        this.manager = manager;
        if (!options || typeof options !== "object") throw new TypeError("Node options are required.");
        if (!this.manager)
            throw new RangeError("Manager has not been initiated.");
        if (this.manager.nodes.has(options.identifier || options.host)) {
            return this.manager.nodes.get(options.identifier || options.host);
        }
        const normalizedOptions = {
            ...options,
            useSSL: options.useSSL ?? options.secure,
            maxRetryAttempts: options.maxRetryAttempts ?? options.retryAmount,
            retryDelayMs: options.retryDelayMs ?? options.retrydelay ?? options.retryDelay,
            enableSessionResumeOption: options.enableSessionResumeOption ?? options.resumeStatus,
            sessionTimeoutMs: options.sessionTimeoutMs ?? options.resumeTimeout,
        };
        (0, nodeCheck_1.default)(normalizedOptions);
        const { password, ...settings } = normalizedOptions;
        this.options = {
            ...settings,
            port: options.port ?? (normalizedOptions.useSSL ? 443 : 2333),
            identifier: options.identifier ?? options.host,
            useSSL: normalizedOptions.useSSL ?? false,
            enableSessionResumeOption: normalizedOptions.enableSessionResumeOption ?? false,
            sessionTimeoutMs: normalizedOptions.sessionTimeoutMs ?? 60000,
            maxRetryAttempts: normalizedOptions.maxRetryAttempts ?? 10,
            retryDelayMs: normalizedOptions.retryDelayMs ?? 1000,
            apiRequestTimeoutMs: options.apiRequestTimeoutMs ?? 10000,
            nodePriority: options.nodePriority ?? 0,
        };
        Object.defineProperty(this.options, "password", { value: password, writable: true });
        this.stats = {
            players: 0,
            playingPlayers: 0,
            uptime: 0,
            memory: {
                free: 0,
                used: 0,
                allocated: 0,
                reservable: 0,
            },
            cpu: {
                cores: 0,
                systemLoad: 0,
                lavalinkLoad: 0,
            },
            frameStats: {
                sent: 0,
                nulled: 0,
                deficit: 0,
            },
        };
        this.rest = new Rest_1.Rest(this, this.manager);
        this.manager.nodes.set(this.options.identifier, this);
        this.manager.emit(Manager_1.ManagerEventTypes.NodeCreate, this);
    }
    [inspect.custom]() {
        return { identifier: this.options.identifier, address: this.address, connected: this.connected };
    }
    /** Returns if connected to the Node. */
    get connected() {
        if (!this.socket)
            return false;
        return !this.destroyed && this.ready && this.socket.readyState === ws_1.default.OPEN;
    }
    /** Returns the address for this node. */
    get address() {
        return `${this.options.host}:${this.options.port}`;
    }
    /** @hidden */
    static init(manager) {
        this.managerRef = new WeakRef(manager);
    }
    get sessionFile() {
        const key = Buffer.from(this.options.identifier).toString("base64url");
        return path_1.default.join(scopePath(this.manager), "nodes", key + ".json");
    }

    loadSessionIds() {
        if (!this.options.enableSessionResumeOption || this.sessionId || this.sessionInvalidated) return;
        try {
            let sessionId;
            try {
                sessionId = JSON.parse(fs_1.default.readFileSync(this.sessionFile, "utf8")).sessionId;
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
                const legacy = path_1.default.join(require("../utils/sessionData").dataRoot, "dist", "sessionData", "sessionIds.json");
                const sessions = JSON.parse(fs_1.default.readFileSync(legacy, "utf8"));
                sessionId = sessions[this.options.identifier + "::" + this.manager.options.clusterId];
            }
            if (typeof sessionId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) this.sessionId = sessionId;
        } catch (error) {
            if (error.code !== "ENOENT") this.error(new Error("Could not read the Lavalink session file."));
        }
    }

    updateSessionId() {
        if (!this.options.enableSessionResumeOption) return;
        const file = this.sessionFile;
        const temporary = file + "." + randomUUID() + ".tmp";
        try {
            fs_1.default.mkdirSync(path_1.default.dirname(file), { recursive: true, mode: 0o700 });
            fs_1.default.writeFileSync(temporary, JSON.stringify({ sessionId: this.sessionId }), { flag: "wx", mode: 0o600 });
            fs_1.default.renameSync(temporary, file);
        } catch {
            this.error(new Error("Could not save the Lavalink session ID."));
        } finally {
            try { fs_1.default.rmSync(temporary, { force: true }); } catch { /* best effort */ }
        }
    }

    invalidateSession(id) {
        if (this.sessionId !== id || this.destroyed) return;
        this.sessionId = null;
        this.rest.setSessionId(null);
        this.sessionInvalidated = true;
        this.updateSessionId();
        this.ready = false;
        this.socket?.terminate();
    }

    connect() {
        if (this.destroyed || this.socket) return;
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
        this.reconnecting = false;
        this.loadSessionIds();
        const headers = {
            Authorization: this.options.password,
            "User-Id": this.manager.options.clientId,
            "Client-Name": this.manager.options.clientName,
        };
        if (this.options.enableSessionResumeOption && this.sessionId) headers["Session-Id"] = this.sessionId;
        const scheme = this.options.useSSL ? "wss" : "ws";
        const socket = new ws_1.default(scheme + "://" + this.address + "/v4/websocket", {
            headers, handshakeTimeout: this.options.apiRequestTimeoutMs ?? 10000, maxPayload: 1024 * 1024,
        });
        this.socket = socket;
        socket.on("open", () => this.open());
        socket.on("close", (code, reason) => {
            if (this.socket === socket) {
                Promise.resolve().then(() => this.close(code, reason.toString())).catch(error => this.error(error));
            }
        });
        socket.on("message", data => this.message(data).catch(error => this.error(error)));
        socket.on("error", () => this.error(new Error("Lavalink WebSocket transport error.")));
    }

    async destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.ready = false;
        clearTimeout(this.reconnectTimeout);
        clearTimeout(this.readyTimeout);
        clearTimeout(this.resumeEndTimer);
        clearInterval(this.heartbeat);
        try {
            await this.movePlayers(true);
        } finally {
            this.socket?.terminate();
            this.socket = null;
            if (this.manager.nodes.get(this.options.identifier) === this) this.manager.nodes.delete(this.options.identifier);
            this.manager.emit(Manager_1.ManagerEventTypes.NodeDestroy, this);
        }
    }

    async movePlayers(destroyRemaining) {
        const players = this.manager.players.values();
        const worker = async () => {
            for (const player of players) {
                if (player.node !== this || player.destroyRequested) continue;
                const tried = new Set();
                while (player.node === this && !player.destroyRequested) {
                    const target = this.manager.getFailoverNode(this, tried);
                    if (!target) break;
                    tried.add(target);
                    try {
                        await player.moveNode(target.options.identifier);
                    } catch (error) {
                        this.error(error);
                    } finally {
                        this.manager.releaseFailoverReservation(target);
                    }
                }
                if (destroyRemaining && player.node === this && !player.destroyRequested) {
                    try { await player.destroy(); } catch (error) { this.error(error); }
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.localPlayers ?? 0, 8) }, worker));
    }

    async reconnect() {
        if (this.destroyed || this.socket || this.reconnecting) return;
        this.reconnecting = true;
        const exhausted = this.reconnectAttempts >= this.options.maxRetryAttempts;
        const delay = Math.min(this.options.retryDelayMs * 2 ** Math.min(this.reconnectAttempts, 20), 60000);
        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = undefined;
            this.reconnecting = false;
            if (this.destroyed || this.socket) return;
            if (exhausted) {
                this.error(new Error("Lavalink reconnect attempts exhausted."));
                this.destroy().catch(error => this.error(error));
                return;
            }
            this.reconnectAttempts++;
            try {
                this.manager.emit(Manager_1.ManagerEventTypes.NodeReconnect, this);
                this.connect();
            } catch (error) {
                this.error(error);
                this.reconnect().catch(nextError => this.error(nextError));
            }
        }, exhausted ? 0 : delay);
        this.reconnectTimeout.unref();
    }

    open() {
        const socket = this.socket;
        this.readyTimeout = setTimeout(() => socket.terminate(), this.options.apiRequestTimeoutMs);
        this.readyTimeout.unref();
        let alive = true;
        socket.on("pong", () => { alive = true; });
        this.heartbeat = setInterval(() => {
            if (!alive) { socket.terminate(); return; }
            alive = false;
            socket.ping();
        }, 30000);
        this.heartbeat.unref();
    }

    async close(code, reason) {
        this.ready = false;
        this.readiness = undefined;
        this.socket = null;
        clearTimeout(this.readyTimeout);
        clearTimeout(this.resumeEndTimer);
        this.resumeEndTimer = undefined;
        clearInterval(this.heartbeat);
        if (this.destroyed) return;
        this.info = null;
        this.manager.emit(Manager_1.ManagerEventTypes.NodeDisconnect, this, { code, reason });
        if (!this.options.enableSessionResumeOption || this.sessionInvalidated) await this.movePlayers(false);
        if (!this.options.enableSessionResumeOption) {
            this.sessionId = null;
            this.rest.setSessionId(null);
        }
        await this.reconnect();
    }

    error(error) {
        if (error) this.manager.emit(Manager_1.ManagerEventTypes.NodeError, this, error);
    }

    async applyReady(payload, socket) {
        if (typeof payload.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.sessionId) ||
            typeof payload.resumed !== "boolean") throw new Error("Invalid Lavalink ready message.");
        const live = () => this.socket === socket && !this.destroyed;
        this.sessionId = payload.sessionId;
        this.rest.setSessionId(payload.sessionId);
        this.sessionInvalidated = false;
        if (this.options.enableSessionResumeOption) {
            await this.rest.updateSession(true, Math.ceil(this.options.sessionTimeoutMs / 1000));
            if (!live()) return;
            this.updateSessionId();
        }
        const info = await this.fetchInfo();
        if (!info || !Array.isArray(info.sourceManagers) || !Array.isArray(info.plugins)) throw new Error("Invalid Lavalink node info response.");
        this.info = info;
        if (!live()) return;
        if (this.options.enableSessionResumeOption) {
            try { await this.manager.loadPlayerStates(this.options.identifier, payload.resumed); }
            catch (error) { this.error(error); }
        }
        for (const player of this.manager.players.values()) {
            if (!live()) return;
            if (player.node !== this || player.destroyRequested) continue;
            try {
                if (!payload.resumed) await player.resyncState();
                await this.manager.sendVoiceUpdate(player);
            } catch (error) {
                this.error(error);
            }
        }
        if (!live()) return;
        this.ready = true;
        this.resumeEndTimer = payload.resumed ? this.manager.scheduleResumedEnds(this) : undefined;
        this.reconnectAttempts = 0;
        this.manager.emit(Manager_1.ManagerEventTypes.NodeConnect, this);
    }
    /**
     * Handles incoming messages from the Lavalink WebSocket connection.
     * @param {Buffer | string} d The message received from the WebSocket connection.
     * @returns {Promise<void>} A promise that resolves when the message is handled.
     * @emits {debug} - Emits a debug event with the message received from the WebSocket connection.
     * @emits {nodeError} - Emits a nodeError event if an unexpected op is received.
     * @emits {nodeRaw} - Emits a nodeRaw event with the raw message received from the WebSocket connection.
     * @private
     */
    async message(data) {
        let payload;
        try { payload = JSON.parse(data.toString()); }
        catch { this.error(new Error("Malformed Lavalink WebSocket message.")); return; }
        if (!payload || typeof payload.op !== "string" || this.destroyed) return;
        const socket = this.socket;
        if (payload.op === "ready") {
            if (this.readiness || !socket || this.destroyed) return;
            clearTimeout(this.readyTimeout);
            this.readiness = this.applyReady(payload, socket);
            try { await this.readiness; }
            catch (error) { socket.terminate(); throw error; }
            this.manager.emit(Manager_1.ManagerEventTypes.NodeRaw, payload);
            return;
        }
        this.manager.emit(Manager_1.ManagerEventTypes.NodeRaw, payload);
        if (payload.op === "stats") {
            if (Number.isFinite(payload.players) && payload.cpu && payload.memory) {
                this.stats = { ...payload };
                delete this.stats.op;
            }
            return;
        }
        if (!this.ready) {
            if (!this.readiness) return;
            await this.readiness;
        }
        if (this.socket !== socket || !this.connected) return;
        const player = this.manager.players.get(payload.guildId);
        if (!player || player.destroyRequested || (player.node !== this && player.movingTo !== this)) return;
        if (payload.op === "playerUpdate") {
            if (player.node !== this) return;
            if (Number.isFinite(payload.state?.position) && !player.pendingOperations) player.position = payload.state.position;
            if (payload.state?.connected === true) {
                clearTimeout(player.voiceRecoveryTimer);
                player.voiceRecoveryTimer = undefined;
                player.voiceRecoveryAttempted = false;
            }
        } else if (payload.op === "event") {
            await this.handleEvent(payload);
        }
    }
    async handleEvent(payload) {
        const player = this.manager.players.get(payload.guildId);
        if (!player || player.destroyRequested) return;
        if ((player.pendingEvents ?? 0) >= 128) {
            this.error(new Error("Too many queued Lavalink events for a player."));
            return;
        }
        player.pendingEvents = (player.pendingEvents ?? 0) + 1;
        const socket = this.socket;
        const processEvent = async () => {
            await player.operationQueue;
            if (player.destroyRequested || player.node !== this || this.socket !== socket) return;
            const track = player.queue.current;
            const type = payload.type;
            if (["TrackStartEvent", "TrackEndEvent", "TrackStuckEvent", "TrackExceptionEvent"].includes(type)) {
                if (!track) return;
                // Lavalink can re-encode a track with its updated playback position.
                const eventId = payload.track?.userData?.pulsifyPlaybackId;
                if (player.playbackId || eventId) {
                    if (eventId !== player.playbackId) return;
                } else if (getEventTrackKey(payload.track) !== track.track) {
                    return;
                }
            }
            switch (type) {
                case "TrackStartEvent": this.trackStart(player, track, payload); break;
                case "TrackEndEvent": {
                    const playbackId = player.playbackId;
                    const terminal = payload.reason !== Utils_1.TrackEndReasonTypes.Replaced &&
                        Object.values(Utils_1.TrackEndReasonTypes).includes(payload.reason);
                    if (terminal) player.pendingResumedEnd = undefined;
                    try {
                        await this.trackEnd(player, track, payload);
                    } finally {
                        if (terminal) player.completeStop(playbackId, track);
                    }
                    break;
                }
                case "TrackStuckEvent": await this.trackStuck(player, track, payload); break;
                case "TrackExceptionEvent": await this.trackError(player, track, payload); break;
                case "WebSocketClosedEvent": this.socketClosed(player, payload); break;
                case "SegmentsLoaded": this.sponsorBlockSegmentLoaded(player, track, payload); break;
                case "SegmentSkipped": this.sponsorBlockSegmentSkipped(player, track, payload); break;
                case "ChaptersLoaded": this.sponsorBlockChaptersLoaded(player, track, payload); break;
                case "ChapterStarted": this.sponsorBlockChapterStarted(player, track, payload); break;
                default: this.error(new Error("Unexpected Lavalink event type."));
            }
        };
        const result = player.eventQueue.then(processEvent);
        player.eventQueue = result.then(() => { player.pendingEvents--; }, () => { player.pendingEvents--; });
        await result;
    }

    trackStart(player, track, payload) {
        if (player.playbackId && player.lastStartedPlaybackId === player.playbackId) return;
        player.lastStartedPlaybackId = player.playbackId;
        const oldPlayer = { ...player };
        player.playing = !player.paused;
        this.manager.emit(Manager_1.ManagerEventTypes.TrackStart, player, track, payload);
        const changeType = player.isAutoplayTrack(track) ? "autoPlay" : "start";
        this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, player, {
            changeType: Manager_1.PlayerStateEventTypes.TrackChange, details: { changeType, track },
        });
    }

    async trackEnd(player, track, payload) {
        const reasons = Utils_1.TrackEndReasonTypes;
        const reason = payload.reason;
        if (reason === reasons.Replaced) return;
        if (!Object.values(reasons).includes(reason)) {
            this.error(new Error("Unexpected Lavalink track end reason."));
            return;
        }
        const oldPlayer = { ...player };
        const socket = this.socket;
        const playbackId = player.playbackId;
        player.playing = player.paused = false;
        player.position = 0;
        player.lastActivityAt = Date.now();
        const message = player.nowPlayingMessage;
        player.nowPlayingMessage = undefined;
        if (message?.deletable) Promise.resolve().then(() => message.delete()).catch(() => { });

        if (reason === reasons.LoadFailed && await this.retryTrack(player, track, playbackId, socket)) return;
        if (!this.ownsPlayer(player, socket) || player.playbackId !== playbackId || player.queue.current !== track) return;
        player.set("trackFailureAttempts", 0);
        const history = player.queue.previous;
        if (history.at(-1)?.track !== track.track) {
            history.push(track);
            if (history.length > this.manager.options.maxPreviousTracks) history.shift();
        }
        if (reason !== reasons.Finished || !player.trackRepeat) {
            const next = player.queue.shift() ?? null;
            if (reason === reasons.Finished && (player.queueRepeat || player.dynamicRepeat)) {
                if (next) player.queue.push(track);
                player.queue.current = next ?? track;
            } else {
                player.queue.current = next;
            }
        }
        player.playbackId = undefined;
        this.manager.emit(Manager_1.ManagerEventTypes.TrackEnd, player, track, payload);
        this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, player, {
            changeType: Manager_1.PlayerStateEventTypes.TrackChange, details: { changeType: "end", track },
        });
        if (reason === reasons.Cleanup || !this.ownsPlayer(player, socket)) return;
        const empty = await player.runOperation(async () => {
            if (!this.ownsPlayer(player, socket) || player.playbackId) return false;
            const next = player.queue.current;
            if (!next) return true;
            if (this.manager.options.playNextOnEnd) await this.startQueuedTrack(player, next, socket);
            return false;
        });
        if (empty && this.ownsPlayer(player, socket)) await this.queueEnd(player, track, payload);
    }

    ownsPlayer(player, socket) {
        return !player.destroyRequested && player.node === this && this.socket === socket;
    }

    async startQueuedTrack(player, track, socket) {
        const playbackId = randomUUID();
        const retries = this.manager.options.trackRetryAttempts;
        for (let attempt = 0; this.ownsPlayer(player, socket) && !player.playbackId && player.queue.current === track; attempt++) {
            try {
                // A failed response may have followed a successful PATCH. Keep its ID
                // and let Lavalink preserve existing playback when retrying.
                await player.playTrack(track, { noReplace: attempt > 0 }, playbackId);
                if (player.playbackId !== playbackId) this.error(new Error("Lavalink already had a different track when advancing the queue."));
                return;
            } catch (error) {
                const retryable = error.name === "LavalinkRequestError" &&
                    (error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500);
                if (attempt >= retries || !retryable) {
                    this.error(error);
                    return;
                }
                await delay(Math.min(25 * 2 ** attempt, 250));
            }
        }
    }

    async retryTrack(player, track, playbackId, socket) {
        return player.runOperation(async () => {
            if (!this.ownsPlayer(player, socket) || player.playbackId !== playbackId || player.queue.current !== track) return false;
            const attempts = player.get("trackFailureAttempts") ?? 0;
            if (attempts >= this.manager.options.trackRetryAttempts) return false;
            player.set("trackFailureAttempts", attempts + 1);
            try { await player.playTrack(track); return true; }
            catch (error) { this.error(error); return false; }
        });
    }

    async queueEnd(player, track, payload) {
        const socket = this.socket;
        const isIdle = () => this.ownsPlayer(player, socket) && !player.playbackId && !player.queue.current && !player.queue.length;
        if (!isIdle() || player.get("queueEndInProgress")) return;
        player.set("queueEndInProgress", true);
        try {
            if (player.autoplayEnabled && (payload.reason === Utils_1.TrackEndReasonTypes.Finished ||
                payload.reason === Utils_1.TrackEndReasonTypes.LoadFailed)) {
                for (let attempt = 0; attempt < player.autoplayTries; attempt++) {
                    if (!isIdle() || !player.autoplayEnabled) return;
                    try {
                        if (!player.isAutoplayTrack(track) || !player.autoplayPool.length) {
                            await player.refreshAutoplayPool(track, player.autoplayPool.length > 0);
                        }
                        if (isIdle() && await player.consumeNextAutoplayTrack()) return;
                    } catch (error) { this.error(error); }
                }
            }
            if (!isIdle()) return;
            player.clearAutoplayPool();
            this.manager.emit(Manager_1.ManagerEventTypes.QueueEnd, player, track, payload);
        } finally {
            player.set("queueEndInProgress", false);
        }
    }
    /**
     * Fetches the lyrics of a track from the Lavalink node.
     * This method uses the `lavalyrics-plugin` to fetch the lyrics.
     * If the plugin is not available, it will throw a RangeError.
     *
     * @param {Track} track - The track to fetch the lyrics for.
     * @param {boolean} [skipTrackSource=false] - Whether to skip using the track's source URL.
     * @returns {Promise<Lyrics>} A promise that resolves with the lyrics data.
     */
    async getLyrics(track, skipTrackSource = false) {
        if (!this.info?.plugins?.some((plugin) => plugin.name === "lavalyrics-plugin"))
            throw new RangeError(`there is no lavalyrics-plugin available in the lavalink node: ${this.options.identifier}`);
        // Make a GET request to the Lavalink node to fetch the lyrics
        // The request includes the track URL and the skipTrackSource parameter
        return ((await this.rest.get(`/v4/lyrics?track=${encodeURIComponent(track.track)}&skipTrackSource=${skipTrackSource}`)) || {
            source: null,
            provider: null,
            text: null,
            lines: [],
            plugin: [],
        });
    }
    /**
     * Handles the event when a track becomes stuck during playback.
     * Stops the current track and emits a `trackStuck` event.
     *
     * @param {Player} player - The player associated with the track that became stuck.
     * @param {Track} track - The track that became stuck.
     * @param {TrackStuckEvent} payload - The event payload containing additional data about the track stuck event.
     * @returns {void}
     * @protected
     */
    async trackStuck(player, track, payload) {
        const socket = this.socket;
        const playbackId = player.playbackId;
        if (await this.recoverTrack(player, track, payload)) return;
        if (!this.ownsPlayer(player, socket) || player.playbackId !== playbackId || player.queue.current !== track) return;
        this.manager.emit(Manager_1.ManagerEventTypes.TrackStuck, player, track, payload);
        if (this.ownsPlayer(player, socket)) await player.stopCurrentPlayback(playbackId, track, this, socket);
    }

    async trackError(player, track, payload) {
        if (await this.recoverTrack(player, track, payload)) return;
        this.manager.emit(Manager_1.ManagerEventTypes.TrackError, player, track, payload);
    }

    async recoverTrack(player, track, payload) {
        const recover = this.manager.options.trackErrorRecovery;
        if (typeof recover !== "function") return false;
        try { return !!(await recover(player, track, payload)); }
        catch { this.error(new Error("Consumer track recovery failed.")); return false; }
    }

    socketClosed(player, payload) {
        this.manager.emit(Manager_1.ManagerEventTypes.SocketClosed, player, payload);
        if (!player.voiceChannelId || player.destroyRequested || player.voiceRecoveryTimer || player.voiceRecoveryAttempted) return;
        const socket = this.socket;
        player.voiceRecoveryAttempted = true;
        player.voiceRecoveryTimer = setTimeout(async () => {
            player.voiceRecoveryTimer = undefined;
            try {
                if (this.ownsPlayer(player, socket) && this.connected && await player.resyncState()) return;
            } catch (error) {
                this.error(error);
            }
            if (!player.voiceRecoveryTimer && player.node === this) player.voiceRecoveryAttempted = false;
        }, 1500);
        player.voiceRecoveryTimer.unref();
    }
    /**
     * Emitted when the segments for a track are loaded.
     * The payload of the event will contain the segments.
     * @param {Player} player - The player associated with the segments.
     * @param {Track} track - The track associated with the segments.
     * @param {SponsorBlockSegmentsLoaded} payload - The event payload containing additional data about the segments loaded event.
     */
    sponsorBlockSegmentLoaded(player, track, payload) {
        return this.manager.emit(Manager_1.ManagerEventTypes.SegmentsLoaded, player, track, payload);
    }
    /**
     * Emitted when a segment of a track is skipped using the sponsorblock plugin.
     * The payload of the event will contain the skipped segment.
     * @param {Player} player - The player associated with the skipped segment.
     * @param {Track} track - The track associated with the skipped segment.
     * @param {SponsorBlockSegmentSkipped} payload - The event payload containing additional data about the segment skipped event.
     */
    sponsorBlockSegmentSkipped(player, track, payload) {
        return this.manager.emit(Manager_1.ManagerEventTypes.SegmentSkipped, player, track, payload);
    }
    /**
     * Emitted when chapters for a track are loaded using the sponsorblock plugin.
     * The payload of the event will contain the chapters.
     * @param {Player} player - The player associated with the chapters.
     * @param {Track} track - The track associated with the chapters.
     * @param {SponsorBlockChaptersLoaded} payload - The event payload containing additional data about the chapters loaded event.
     */
    sponsorBlockChaptersLoaded(player, track, payload) {
        return this.manager.emit(Manager_1.ManagerEventTypes.ChaptersLoaded, player, track, payload);
    }
    /**
     * Emitted when a chapter of a track is started using the sponsorblock plugin.
     * The payload of the event will contain the started chapter.
     * @param {Player} player - The player associated with the started chapter.
     * @param {Track} track - The track associated with the started chapter.
     * @param {SponsorBlockChapterStarted} payload - The event payload containing additional data about the chapter started event.
     */
    sponsorBlockChapterStarted(player, track, payload) {
        return this.manager.emit(Manager_1.ManagerEventTypes.ChapterStarted, player, track, payload);
    }
    /**
     * Fetches Lavalink node information.
     * @returns {Promise<LavalinkInfo>} A promise that resolves to the Lavalink node information.
     */
    async fetchInfo() {
        return (await this.rest.get(`/v4/info`));
    }
    /**
     * Gets the current sponsorblock segments for a player.
     * @param {Player} player - The player to get the sponsorblocks for.
     * @returns {Promise<SponsorBlockSegment[]>} A promise that resolves to the sponsorblock segments.
     * @throws {RangeError} If the sponsorblock-plugin is not available in the Lavalink node.
     */
    async getSponsorBlock(player) {
        if (!this.info?.plugins?.some((plugin) => plugin.name === "sponsorblock-plugin"))
            throw new RangeError(`there is no sponsorblock-plugin available in the lavalink node: ${this.options.identifier}`);
        return (await this.rest.get(this.rest.sessionPath(player.guildId) + "/sponsorblock/categories"));
    }
    /**
     * Sets the sponsorblock segments for a player.
     * @param {Player} player - The player to set the sponsor blocks for.
     * @param {SponsorBlockSegment[]} segments - The sponsorblock segments to set. Defaults to `[SponsorBlockSegment.Sponsor, SponsorBlockSegment.SelfPromo]` if not provided.
     * @returns {Promise<void>} The promise is resolved when the operation is complete.
     * @throws {RangeError} If the sponsorblock-plugin is not available in the Lavalink node.
     * @throws {RangeError} If no segments are provided.
     * @throws {SyntaxError} If an invalid sponsorblock is provided.
     * @example
     * ```ts
     * // use it on the player via player.setSponsorBlock();
     * player.setSponsorBlock([SponsorBlockSegment.Sponsor, SponsorBlockSegment.SelfPromo]);
     * ```
     */
    async setSponsorBlock(player, segments = [SponsorBlockSegment.Sponsor, SponsorBlockSegment.SelfPromo]) {
        if (!this.info?.plugins?.some((plugin) => plugin.name === "sponsorblock-plugin"))
            throw new RangeError(`there is no sponsorblock-plugin available in the lavalink node: ${this.options.identifier}`);
        if (!segments.length)
            throw new RangeError("No Segments provided. Did you mean to use 'deleteSponsorBlock'?");
        if (segments.some((v) => !validSponsorBlocks.includes(v.toLowerCase())))
            throw new SyntaxError(`You provided a sponsorblock which isn't valid, valid ones are: ${validSponsorBlocks.map((v) => `'${v}'`).join(", ")}`);
        await this.rest.put(this.rest.sessionPath(player.guildId) + "/sponsorblock/categories", JSON.stringify(segments.map((v) => v.toLowerCase())));
        return;
    }
    /**
     * Deletes the sponsorblock segments for a player.
     * @param {Player} player - The player to delete the sponsorblocks for.
     * @returns {Promise<void>} The promise is resolved when the operation is complete.
     * @throws {RangeError} If the sponsorblock-plugin is not available in the Lavalink node.
     */
    async deleteSponsorBlock(player) {
        if (!this.info?.plugins?.some((plugin) => plugin.name === "sponsorblock-plugin"))
            throw new RangeError(`there is no sponsorblock-plugin available in the lavalink node: ${this.options.identifier}`);
        await this.rest.delete(this.rest.sessionPath(player.guildId) + "/sponsorblock/categories");
        return;
    }
}
exports.Node = Node;
