"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Player = void 0;
const tslib_1 = require("tslib");
const Filters_1 = require("./Filters");
const Manager_1 = require("./Manager");
const Node_1 = require("./Node");
const Queue_1 = require("./Queue");
const Utils_1 = require("./Utils");
const { randomUUID } = require("node:crypto");
const { inspect } = require("node:util");
const playerCheck_1 = tslib_1.__importDefault(require("../utils/playerCheck"));
class Player {
    options;
    /** The Queue for the Player. */
    queue;
    /** The filters applied to the audio. */
    filters;
    /** Whether the queue repeats the track. */
    trackRepeat = false;
    /** Whether the queue repeats the queue. */
    queueRepeat = false;
    /**Whether the queue repeats and shuffles after each song. */
    dynamicRepeat = false;
    /** The time the player is in the track. */
    position = 0;
    /** Whether the player is playing. */
    playing = false;
    /** Whether the player is paused. */
    paused = false;
    /** The volume for the player */
    volume = 100;
    /** The Node for the Player. */
    node;
    /** The guild ID for the player. */
    guildId;
    /** The voice channel for the player. */
    voiceChannelId = null;
    /** The text channel for the player. */
    textChannelId = null;
    /**The now playing message. */
    nowPlayingMessage;
    /** The current state of the player. */
    state = Utils_1.StateTypes.Disconnected;
    /** The equalizer bands array. */
    bands = new Array(15).fill(0.0);
    /** The voice state object from Discord. */
    voiceState;
    /** The Manager. */
    manager;
    /** The autoplay state of the player. */
    isAutoplay = false;
    /** The number of times to try autoplay before emitting queueEnd. */
    autoplayTries = 3;
    /** Whether autoplay is enabled for pool-based recommendations. */
    autoplayEnabled = false;
    /** Recently played autoplay track identifiers/titles. */
    autoplayHistory = [];
    autoplayRecommendationAt = 0;
    /** Last time this player had user/playback activity. */
    lastActivityAt = Date.now();
    operationQueue = Promise.resolve();
    pendingOperations = 0;
    playbackId;
    destroyTask;
    /** Serializes Lavalink events for this player. */
    eventQueue = Promise.resolve();
    destroyRequested = false;
    /** Remaining autoplay candidates for this player. */
    autoplayPool = [];
    /** The last track identifier used to build the autoplay pool. */
    lastAutoplaySeedTrackId = null;
    /** The last user-requested track identifier seen by the player. */
    lastUserRequestedTrackId = null;
    static managerRef;
    data = Object.create(null);
    dynamicLoopInterval = null;
    dynamicRepeatIntervalMs = null;
    /**
     * Creates a new player, returns one if it already exists.
     * @param options The player options.
     * @see https://docs.magmastream.com/main/introduction/getting-started
     */
    constructor(options, manager = Utils_1.Structure.constructingManager ?? new.target.managerRef?.deref()) {
        this.manager = manager;
        (0, playerCheck_1.default)(options);
        this.options = { ...options };
        if (!this.manager)
            throw new RangeError("Manager has not been initiated.");
        // If a player with the same guild ID already exists, return it.
        if (this.manager.players.has(options.guildId)) {
            return this.manager.players.get(options.guildId);
        }
        // Check the player options for errors.
        // Set the guild ID and voice state.
        this.guildId = options.guildId;
        Object.defineProperty(this, "voiceState", {
            value: { op: "voiceUpdate", guild_id: options.guildId },
        });
        // Set the voice and text channels if they exist.
        if (options.voiceChannelId)
            this.voiceChannelId = options.voiceChannelId;
        if (options.textChannelId)
            this.textChannelId = options.textChannelId;
        // Set the node to use, either the specified node or the first available node.
        const node = this.manager.nodes.get(options.node);
        if (options.node && !node) throw new RangeError("Unknown Lavalink node.");
        this.node = node || this.manager.useableNode;
        // If no node is available, throw an error.
        if (!this.node)
            throw new RangeError("No available nodes.");
        // Initialize the queue with the guild ID and manager.
        this.queue = new Queue_1.Queue(this.guildId, this.manager);
        this.queue.previous = new Array();
        // Add the player to the manager's player collection.
        this.manager.players.set(options.guildId, this);
        this.node.localPlayers = (this.node.localPlayers ?? 0) + 1;
        this.manager.watchInactivePlayers();
        // Set the initial volume locally. A REST sync can happen later once session is ready.
        this.volume = options.volume ?? 100;
        // Initialize the filters.
        this.filters = new Filters_1.Filters(this);
        // Emit the playerCreate event.
        this.manager.emit(Manager_1.ManagerEventTypes.PlayerCreate, this);
    }
    [inspect.custom]() {
        return { guildId: this.guildId, node: this.node.options.identifier, playing: this.playing, queued: this.queue.length };
    }

    runOperation(operation) {
        if (this.destroyRequested) return Promise.reject(new Error("Player has been destroyed."));
        if (this.pendingOperations >= 128) return Promise.reject(new Error("Too many pending player operations."));
        this.pendingOperations++;
        const result = this.operationQueue.then(() => {
            if (this.destroyRequested) throw new Error("Player has been destroyed.");
            return operation();
        });
        this.operationQueue = result.then(() => { this.pendingOperations--; }, () => { this.pendingOperations--; });
        return result;
    }

    /**
     * Set custom data.
     * @param key - The key to set the data for.
     * @param value - The value to set the data to.
     */
    set(key, value) {
        // Store the data in the data object using the key.
        this.data[key] = value;
    }
    /**
     * Retrieves custom data associated with a given key.
     * @template T - The expected type of the data.
     * @param {string} key - The key to retrieve the data for.
     * @returns {T} - The data associated with the key, cast to the specified type.
     */
    get(key) {
        // Access the data object using the key and cast it to the specified type T.
        return this.data[key];
    }
    /**
     * Initializes the static properties of the Player class.
     * @hidden
     * @param manager The Manager to use.
     */
    static init(manager) {
        // Set the Manager to use.
        this.managerRef = new WeakRef(manager);
    }

    /**
   * Same as Manager#search() but a shortcut on the player itself.
   * @param query
   * @param requester
   * @param sourcePlatforms
   */
    async search(query, requester, sourcePlatforms) {
        return await this.manager.search(query, requester, sourcePlatforms);
    }
    /**
     * Connects the player to the voice channel.
     * @throws {RangeError} If no voice channel has been set.
     * @returns {void}
     */
    connect(force = false) {
        if (this.destroyRequested) throw new Error("Player has been destroyed.");
        if (!force && this.state === Utils_1.StateTypes.Connected && this.requestedVoiceChannel === this.voiceChannelId) return;
        this.lastActivityAt = Date.now();
        // Check if the voice channel has been set.
        if (!this.voiceChannelId) {
            throw new RangeError("No voice channel has been set. You must use the `setVoiceChannelId()` method to set the voice channel before connecting.");
        }
        // Set the player state to connecting.
        // Clone the current player state for comparison.
        const oldPlayer = this ? { ...this } : null;
        // Send the voice state update to the gateway.
        this.manager.options.send(this.guildId, {
            op: 4,
            d: {
                guild_id: this.guildId,
                channel_id: this.voiceChannelId,
                self_mute: this.options.selfMute || false,
                self_deaf: this.options.selfDeafen || false,
            },
        });
        // Set the player state to connected.
        this.requestedVoiceChannel = this.voiceChannelId;
        this.state = Utils_1.StateTypes.Connected;
        // Emit the player state update event.
        this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this, {
            changeType: Manager_1.PlayerStateEventTypes.ConnectionChange,
            details: {
                changeType: "connect",
                previousConnection: oldPlayer?.state === Utils_1.StateTypes.Connected,
                currentConnection: true,
            },
        });
    }
    /**
     * Disconnects the player from the voice channel.
     * @throws {TypeError} If the player is not connected.
     * @returns {this} - The current instance of the Player class for method chaining.
     */
    async disconnect() {
        if (!this.destroyRequested && this.voiceChannelId) {
            const oldPlayer = { ...this };
            await this.destroy();
            this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this, {
                changeType: Manager_1.PlayerStateEventTypes.ConnectionChange,
                details: { changeType: "disconnect", previousConnection: true, currentConnection: false },
            });
        }
        return this;
    }

    leaveVoice() {
        this.manager.options.send(this.guildId, {
            op: 4, d: { guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false },
        });
        this.requestedVoiceChannel = null;
        this.voiceChannelId = null;
    }

    destroy(disconnect = true, preserveSession = false) {
        if (this.destroyTask) return this.destroyTask;
        this.destroyRequested = true;
        const oldPlayer = { ...this };
        this.state = Utils_1.StateTypes.Destroying;
        clearInterval(this.dynamicLoopInterval);
        clearTimeout(this.voiceRecoveryTimer);
        this.destroyTask = this.operationQueue.then(async () => {
            const failures = [];
            if (!preserveSession) {
                if (disconnect && this.voiceChannelId) {
                    try { this.leaveVoice(); } catch (error) { failures.push(error); }
                }
                try { await this.node.rest.destroyPlayer(this.guildId); } catch (error) { failures.push(error); }
                try { await this.manager.removePlayerState(this.guildId); } catch (error) { failures.push(error); }
            }
            this.queue.length = 0;
            this.queue.current = null;
            this.queue.previous = [];
            this.clearAutoplayPool();
            this.autoplayEnabled = this.isAutoplay = false;
            this.playing = this.paused = false;
            this.voiceChannelId = null;
            delete this.voiceState.event;
            delete this.voiceState.sent;
            delete this.voiceState.sessionId;
            delete this.voiceState.channelId;
            this.state = Utils_1.StateTypes.Disconnected;
            const registered = this.manager.players.get(this.guildId) === this;
            if (registered) {
                this.node.localPlayers--;
                this.manager.players.delete(this.guildId);
            }
            this.manager.stopWatchingIdlePlayers();
            this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, null, {
                changeType: Manager_1.PlayerStateEventTypes.PlayerDestroy,
            });
            this.manager.emit(Manager_1.ManagerEventTypes.PlayerDestroy, this);
            if (failures.length) throw new AggregateError(failures, "Pulsify could not finish all player cleanup.");
            return registered;
        });
        return this.destroyTask;
    }
    /**
     * Sets the player voice channel.
     * @param {string} channel - The new voice channel ID.
     * @returns {this} - The player instance.
     * @throws {TypeError} If the channel parameter is not a string.
     */
    setVoiceChannelId(channel) {
        // Validate the channel parameter
        if (typeof channel !== "string" || !/^\d+$/.test(channel))
            throw new TypeError("Channel must be a Discord ID string.");
        // Clone the current player state for comparison
        const oldPlayer = this ? { ...this } : null;
        // Update the player voice channel
        this.voiceChannelId = channel;
        this.connect();
        // Emit a player state update event
        this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this, {
            changeType: Manager_1.PlayerStateEventTypes.ChannelChange,
            details: {
                changeType: "voice",
                previousChannel: oldPlayer.voiceChannelId || null,
                currentChannel: this.voiceChannelId,
            },
        });
        return this;
    }
    /**
     * Sets the player text channel.
     *
     * This method updates the text channel associated with the player. It also
     * emits a player state update event indicating the change in the channel.
     *
     * @param {string} channel - The new text channel ID.
     * @returns {this} - The player instance for method chaining.
     * @throws {TypeError} If the channel parameter is not a string.
     */
    setTextChannelId(channel) {
        // Validate the channel parameter
        if (typeof channel !== "string" || !/^\d+$/.test(channel))
            throw new TypeError("Channel must be a Discord ID string.");
        // Clone the current player state for comparison
        const oldPlayer = this ? { ...this } : null;
        // Update the text channel property
        this.textChannelId = channel;
        // Emit a player state update event with channel change details
        this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this, {
            changeType: Manager_1.PlayerStateEventTypes.ChannelChange,
            details: {
                changeType: "text",
                previousChannel: oldPlayer.textChannelId || null,
                currentChannel: this.textChannelId,
            },
        });
        // Return the player instance for chaining
        return this;
    }
    /**
     * Sets the now playing message.
     *
     * @param message - The message of the now playing message.
     * @returns The now playing message.
     */
    setNowPlayingMessage(message) {
        if (!message) {
            throw new TypeError("You must provide the message of the now playing message.");
        }
        this.nowPlayingMessage = message;
        return this.nowPlayingMessage;
    }
    async play(optionsOrTrack, playOptions) {
        return this.runOperation(() => this.playTrack(optionsOrTrack, playOptions));
    }

    async playTrack(optionsOrTrack, playOptions) {
        const explicitTrack = !Array.isArray(optionsOrTrack) && Utils_1.TrackUtils.validate(optionsOrTrack);
        const track = explicitTrack ? optionsOrTrack : this.queue.current;
        if (!Utils_1.TrackUtils.validate(track)) throw new RangeError("No current track.");
        const options = playOptions ?? (explicitTrack ? {} : optionsOrTrack) ?? {};
        const { startTime, endTime, noReplace = false } = options;
        for (const value of [startTime, endTime]) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError("Playback times must be non-negative integer milliseconds.");
        }
        if (endTime !== undefined && endTime <= (startTime ?? 0)) throw new RangeError("endTime must be after startTime.");
        const playbackId = randomUUID();
        const response = await this.node.rest.updatePlayer({
            guildId: this.guildId,
            noReplace,
            data: {
                track: { encoded: track.track, userData: { pulsifyPlaybackId: playbackId } },
                position: startTime ?? 0, endTime, paused: false, volume: this.volume,
            },
        });
        if (noReplace && response?.track?.userData?.pulsifyPlaybackId !== playbackId) return this;
        this.playbackId = playbackId;
        if (this.queue.current !== track) this.set("trackFailureAttempts", 0);
        this.queue.current = track;
        if (!this.isAutoplayTrack(track)) this.lastUserRequestedTrackId = track.identifier ?? null;
        this.lastActivityAt = Date.now();
        this.position = startTime ?? 0;
        this.playing = true;
        this.paused = false;
        return this;
    }
    /**
     * Sets the autoplay-state of the player.
     *
     * Autoplay is a feature that makes the player play a recommended
     * track when the current track ends.
     *
     * @param {boolean} autoplayState - Whether or not autoplay should be enabled.
     * @param {object} botUser - The user-object that should be used as the bot-user.
     * @param {number} [tries=3] - The number of times the player should try to find a
     * recommended track if the first one doesn't work.
     * @returns {this} - The player instance.
     */
    setAutoplay(autoplayState, botUser, tries) {
        const oldPlayer = { ...this };
        if (typeof autoplayState !== "boolean") {
            throw new Error("autoplayState must be a boolean.");
        }
        if (autoplayState) {
            if (!botUser) {
                throw new Error("botUser must be provided when enabling autoplay.");
            }
            if (typeof botUser.id !== "string" || !botUser.id) {
                throw new Error("botUser must be a user-object.");
            }
            if (tries != null && (!Number.isSafeInteger(tries) || tries < 1 || tries > 10)) throw new RangeError("Autoplay tries must be between 1 and 10.");
            this.autoplayTries = tries ?? 3;
            this.isAutoplay = true;
            this.autoplayEnabled = true;
            this.set("Internal_BotUser", botUser);
        }
        else {
            this.isAutoplay = false;
            this.autoplayEnabled = false;
            this.autoplayTries = null;
            this.clearAutoplayPool();
            this.set("Internal_BotUser", null);
        }
        this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this, {
            changeType: Manager_1.PlayerStateEventTypes.AutoPlayChange,
            details: {
                previousAutoplay: oldPlayer.isAutoplay,
                currentAutoplay: this.isAutoplay,
            },
        });
        return this;
    }
    /**
     * Gets recommended tracks and returns an array of tracks.
     * @param {Track} track - The track to find recommendations for.
     * @returns {Promise<Track[]>} - Array of recommended tracks.
     */
    async getRecommendedTracks(track) {
        const tracks = await Utils_1.AutoPlayUtils.getRecommendedTracks(track, this.manager, this.node);
        return tracks;
    }
    clearAutoplayPool() {
        this.autoplayPool = [];
        this.lastAutoplaySeedTrackId = null;
        this.autoplayHistory = [];
        return this;
    }
    normalizeTitle(title) {
        if (!title)
            return "";
        return String(title)
            .toLowerCase()
            .replace(/\[[^\]]*\]|\([^\)]*\)/g, " ")
            .replace(/\s-\s.*$/, " ")
            .replace(/\s+/g, " ")
            .trim();
    }
    isAutoplayTrack(track) {
        const botUser = this.get("Internal_BotUser");
        return !!(track && botUser && track.requester?.id && botUser.id === track.requester.id);
    }
    createAutoplayTrack(track) {
        const botUser = this.get("Internal_BotUser");
        if (!track || !botUser)
            return null;
        return {
            ...track,
            requester: botUser,
        };
    }
    filterAutoplayTracks(tracks, seedTrack) {
        const seedIdentifier = seedTrack?.identifier ?? null;
        const seedTitle = this.normalizeTitle(seedTrack?.title);
        const seenIdentifiers = new Set(seedIdentifier ? [seedIdentifier] : []);
        const seenTitles = new Set(seedTitle ? [seedTitle] : []);
        const history = new Set(this.autoplayHistory ?? []);
        const filtered = [];
        for (const originalTrack of tracks) {
            const track = this.createAutoplayTrack(originalTrack);
            if (!track?.identifier)
                continue;
            const normalizedTitle = this.normalizeTitle(track.title);
            if (seedIdentifier && track.identifier === seedIdentifier)
                continue;
            if (history.has(track.identifier))
                continue;
            if (seedTitle && normalizedTitle && normalizedTitle === seedTitle)
                continue;
            if (seenIdentifiers.has(track.identifier))
                continue;
            if (normalizedTitle && seenTitles.has(normalizedTitle))
                continue;
            seenIdentifiers.add(track.identifier);
            if (normalizedTitle) {
                seenTitles.add(normalizedTitle);
            }
            filtered.push(track);
        }
        return filtered;
    }
    mergeAndShuffleAutoplayPool(oldPool, newPool, seedTrack) {
        const tracks = this.filterAutoplayTracks([...(oldPool ?? []), ...(newPool ?? [])], seedTrack);
        for (let index = tracks.length - 1; index > 0; index--) {
            const other = Math.floor(Math.random() * (index + 1));
            [tracks[index], tracks[other]] = [tracks[other], tracks[index]];
        }
        return tracks.slice(0, 100);
    }
    async refreshAutoplayPool(seedTrack, mergeExisting = false) {
        const preparedSeedTrack = this.createAutoplayTrack(seedTrack);
        if (!preparedSeedTrack)
            return [];
        const now = Date.now();
        if (now - this.autoplayRecommendationAt < 5000 && this.autoplayPool.length)
            return this.autoplayPool;
        this.autoplayRecommendationAt = now;
        const freshTracks = this.filterAutoplayTracks(await this.getRecommendedTracks(preparedSeedTrack), preparedSeedTrack);
        if (this.destroyRequested || !this.autoplayEnabled) return [];
        this.autoplayPool = mergeExisting
            ? this.mergeAndShuffleAutoplayPool(this.autoplayPool, freshTracks, preparedSeedTrack)
            : freshTracks.slice(0, 100);
        this.lastAutoplaySeedTrackId = preparedSeedTrack.identifier ?? null;
        return this.autoplayPool;
    }
    async consumeNextAutoplayTrack() {
        if (!this.autoplayEnabled || !this.autoplayPool.length)
            return false;
        const nextTrack = this.autoplayPool.shift();
        if (!nextTrack)
            return false;
        if (this.destroyRequested || this.queue.current || this.queue.length) return false;
        await this.play(nextTrack);
        this.autoplayHistory.push(nextTrack.identifier);
        if (this.autoplayHistory.length > 25) this.autoplayHistory.shift();
        return true;
    }
    /**
     * Sets the volume of the player.
     * @param {number} volume - The new volume. Must be between 0 and 1000.
     * @returns {Promise<Player>} - The updated player.
     * @throws {TypeError} If the volume is not a number.
     * @throws {RangeError} If the volume is not between 0 and 1000.
     * @emits {PlayerStateUpdate} - Emitted when the volume is changed.
     * @example
     * player.setVolume(50);
     */
    async setVolume(volume) {
        if (!Number.isInteger(volume) || volume < 0 || volume > 1000) throw new RangeError("Volume must be an integer between 0 and 1000.");
        return this.runOperation(async () => {
            const oldPlayer = { ...this };
            await this.node.rest.updatePlayer({ guildId: this.guildId, data: { volume } });
            this.volume = volume;
            this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this, {
                changeType: Manager_1.PlayerStateEventTypes.VolumeChange,
                details: { previousVolume: oldPlayer.volume, currentVolume: volume },
            });
            return this;
        });
    }
    /**
     * Sets the sponsorblock for the player. This will set the sponsorblock segments for the player to the given segments.
     * @param {SponsorBlockSegment[]} segments - The sponsorblock segments to set. Defaults to `[SponsorBlockSegment.Sponsor, SponsorBlockSegment.SelfPromo]` if not provided.
     * @returns {Promise<void>} The promise is resolved when the operation is complete.
     */
    async setSponsorBlock(segments = [Node_1.SponsorBlockSegment.Sponsor, Node_1.SponsorBlockSegment.SelfPromo]) {
        return this.node.setSponsorBlock(this, segments);
    }
    /**
     * Gets the sponsorblock for the player.
     * @returns {Promise<SponsorBlockSegment[]>} The sponsorblock segments.
     */
    async getSponsorBlock() {
        return this.node.getSponsorBlock(this);
    }
    /**
     * Deletes the sponsorblock for the player. This will remove all sponsorblock segments that have been set for the player.
     * @returns {Promise<void>}
     */
    async deleteSponsorBlock() {
        return this.node.deleteSponsorBlock(this);
    }
    /**
     * Sets the track repeat mode.
     * When track repeat is enabled, the current track will replay after it ends.
     * Disables queueRepeat and dynamicRepeat modes if enabled.
     *
     * @param repeat - A boolean indicating whether to enable track repeat.
     * @returns {this} - The player instance.
     * @throws {TypeError} If the repeat parameter is not a boolean.
     */
    setTrackRepeat(repeat) {
        // Ensure the repeat parameter is a boolean
        if (typeof repeat !== "boolean")
            throw new TypeError('Repeat can only be "true" or "false".');
        // Clone the current player state for event emission
        const oldPlayer = this ? { ...this } : null;
        if (repeat) {
            // Enable track repeat and disable other repeat modes
            this.trackRepeat = true;
            this.queueRepeat = false;
            this.dynamicRepeat = false;
        }
        else {
            // Disable all repeat modes
            this.trackRepeat = false;
            this.queueRepeat = false;
            this.dynamicRepeat = false;
        }
        // Emit an event indicating the repeat mode has changed
        this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this, {
            changeType: Manager_1.PlayerStateEventTypes.RepeatChange,
            details: {
                changeType: "track",
                previousRepeat: this.getRepeatState(oldPlayer),
                currentRepeat: this.getRepeatState(this),
            },
        });
        return this;
    }
    /**
     * Sets the queue repeat.
     * @param repeat Whether to repeat the queue or not
     * @returns {this} - The player instance.
     * @throws {TypeError} If the repeat parameter is not a boolean
     */
    setQueueRepeat(repeat) {
        // Ensure the repeat parameter is a boolean
        if (typeof repeat !== "boolean")
            throw new TypeError('Repeat can only be "true" or "false".');
        // Get the current player state
        const oldPlayer = this ? { ...this } : null;
        // Update the player state
        if (repeat) {
            this.trackRepeat = false;
            this.queueRepeat = true;
            this.dynamicRepeat = false;
        }
        else {
            this.trackRepeat = false;
            this.queueRepeat = false;
            this.dynamicRepeat = false;
        }
        // Emit the player state update event
        this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this, {
            changeType: Manager_1.PlayerStateEventTypes.RepeatChange,
            details: {
                changeType: "queue",
                previousRepeat: this.getRepeatState(oldPlayer),
                currentRepeat: this.getRepeatState(this),
            },
        });
        return this;
    }
    /**
     * Sets the queue to repeat and shuffles the queue after each song.
     * @param repeat "true" or "false".
     * @param ms After how many milliseconds to trigger dynamic repeat.
     * @returns {this} - The player instance.
     * @throws {TypeError} If the repeat parameter is not a boolean.
     * @throws {RangeError} If the queue size is less than or equal to 1.
     */
    setDynamicRepeat(repeat, ms) {
        // Validate the repeat parameter
        if (typeof repeat !== "boolean") {
            throw new TypeError('Repeat can only be "true" or "false".');
        }
        // Ensure the queue has more than one track for dynamic repeat
        if (repeat && this.queue.size <= 1) {
            throw new RangeError("The queue size must be greater than 1.");
        }
        // Clone the current player state for comparison
        const oldPlayer = this ? { ...this } : null;
        if (repeat) {
            if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2147483647) throw new RangeError("Invalid repeat interval.");
            // Disable other repeat modes when dynamic repeat is enabled
            this.trackRepeat = false;
            this.queueRepeat = false;
            this.dynamicRepeat = true;
            if (this.dynamicLoopInterval) {
                clearInterval(this.dynamicLoopInterval);
                this.dynamicLoopInterval = null;
            }
            // Set an interval to shuffle the queue periodically
            this.dynamicLoopInterval = setInterval(() => {
                if (!this.dynamicRepeat)
                    return;
                this.queue.shuffle();
            }, ms);
            this.dynamicLoopInterval.unref();
            // Store the ms value
            this.dynamicRepeatIntervalMs = ms;
        }
        else {
            // Clear the interval and reset repeat states
            clearInterval(this.dynamicLoopInterval);
            this.dynamicLoopInterval = null;
            this.dynamicRepeatIntervalMs = null;
            this.trackRepeat = false;
            this.queueRepeat = false;
            this.dynamicRepeat = false;
        }
        // Emit a player state update event
        this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this, {
            changeType: Manager_1.PlayerStateEventTypes.RepeatChange,
            details: {
                changeType: "dynamic",
                previousRepeat: this.getRepeatState(oldPlayer),
                currentRepeat: this.getRepeatState(this),
            },
        });
        return this;
    }
    /**
     * Restarts the currently playing track from the beginning.
     * If there is no track playing, it will play the next track in the queue.
     * @returns {Promise<Player>} The current instance of the Player class for method chaining.
     */
    async restart() {
        return this.runOperation(async () => {
            if (!this.queue.current) this.queue.current = this.queue.shift() ?? null;
            return this.queue.current ? this.playTrack() : this;
        });
    }

    async stop(amount = 1) {
        if (!Number.isSafeInteger(amount) || amount < 1) throw new RangeError("Skip amount must be a positive integer.");
        return this.runOperation(async () => {
            if (amount > this.queue.totalSize && amount > 1) throw new RangeError("Cannot skip more than the queue length.");
            if (!this.queue.current) return this;
            const oldPlayer = { ...this };
            await this.node.rest.updatePlayer({ guildId: this.guildId, data: { track: { encoded: null } } });
            const tracks = this.queue.splice(0, amount - 1);
            this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this, {
                changeType: Manager_1.PlayerStateEventTypes.QueueChange, details: { changeType: "remove", tracks },
            });
            return this;
        });
    }

    async pause(pause) {
        if (typeof pause !== "boolean") throw new TypeError("Pause must be a boolean.");
        return this.runOperation(async () => {
            if (this.paused === pause || !this.queue.current) return this;
            const oldPlayer = { ...this };
            await this.node.rest.updatePlayer({ guildId: this.guildId, data: { paused: pause } });
            this.playing = !pause;
            this.paused = pause;
            this.lastActivityAt = Date.now();
            this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this, {
                changeType: Manager_1.PlayerStateEventTypes.PauseChange,
                details: { previousPause: oldPlayer.paused, currentPause: pause },
            });
            return this;
        });
    }

    async previous() {
        return this.runOperation(async () => {
            const previous = this.queue.previous.at(-1);
            if (!previous) throw new Error("There is no previous track.");
            const current = this.queue.current;
            await this.playTrack(previous);
            this.queue.previous.pop();
            if (current && this.queue[0] !== current && this.queue.totalSize < this.manager.options.maxQueueSize) this.queue.unshift(current);
            return this;
        });
    }

    async seek(position) {
        if (!Number.isFinite(position)) throw new RangeError("Position must be a finite number.");
        return this.runOperation(async () => {
            if (!this.queue.current) return undefined;
            if (this.queue.current.isSeekable === false) throw new RangeError("Current track does not support seeking.");
            const oldPlayer = { ...this };
            const target = Math.trunc(Math.max(0, Math.min(position, this.queue.current.duration ?? Infinity)));
            await this.node.rest.updatePlayer({ guildId: this.guildId, data: { position: target } });
            this.position = target;
            this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this, {
                changeType: Manager_1.PlayerStateEventTypes.TrackChange,
                details: { changeType: "timeUpdate", previousTime: oldPlayer.position, currentTime: target },
            });
            return this;
        });
    }
    /**
     * Returns the current repeat state of the player.
     * @param player The player to get the repeat state from.
     * @returns The repeat state of the player, or null if it is not repeating.
     */
    getRepeatState(player) {
        // If the queue is repeating, return the queue repeat state.
        if (player.queueRepeat)
            return "queue";
        // If the track is repeating, return the track repeat state.
        if (player.trackRepeat)
            return "track";
        // If the dynamic repeat is enabled, return the dynamic repeat state.
        if (player.dynamicRepeat)
            return "dynamic";
        // If none of the above conditions are met, return null.
        return null;
    }
    /**
     * Re-syncs the current player state with Lavalink.
     * This is used after node reconnects or Discord voice websocket interruptions.
     * @returns {Promise<boolean>} Whether a sync payload was sent.
     */
    async resyncState() {
        return this.runOperation(() => this.restoreOn(this.node));
    }

    async restoreOn(node) {
        if (!node.sessionId || !this.voiceChannelId) return false;
        const { event, channelId, sessionId } = this.voiceState;
        const voice = event?.token && event.endpoint && channelId && sessionId
            ? { ...event, channelId, sessionId } : undefined;
        const playbackId = randomUUID();
        const track = this.playing || this.paused ? this.queue.current : null;
        await node.rest.updatePlayer({
            guildId: this.guildId,
            data: {
                paused: this.paused, volume: this.volume, position: track?.isSeekable === false ? 0 : this.position,
                track: { encoded: track?.track ?? null, userData: { pulsifyPlaybackId: playbackId } },
                filters: this.filters.payload(), voice,
            },
        });
        this.playbackId = playbackId;
        this.playing = !!track && !this.paused;
        if (voice) this.voiceState.sent = { ...voice, event, node, nodeSession: node.sessionId };
        else this.connect(true);
        return true;
    }

    async autoMoveNode() {
        const node = this.manager.getFailoverNode(this.node);
        if (!node) return this;
        try { return await this.moveNode(node.options.identifier); }
        finally { this.manager.releaseFailoverReservation(node); }
    }

    async moveNode(identifier) {
        return this.runOperation(async () => {
            const node = this.manager.nodes.get(identifier);
            if (!node?.connected) throw new Error("Destination Lavalink node is unavailable.");
            const oldNode = this.node;
            if (node === oldNode) return this;
            this.movingTo = node;
            try {
                if (!await this.restoreOn(node)) throw new Error("Player could not be restored on the destination node.");
            } finally {
                this.movingTo = undefined;
            }
            oldNode.localPlayers--;
            node.localPlayers = (node.localPlayers ?? 0) + 1;
            this.node = node;
            this.options.node = identifier;
            try { await oldNode.rest.destroyPlayer(this.guildId); }
            catch (error) { oldNode.error(error); }
            return this;
        });
    }
    /**
     * Transfers the player to a new server. If the player already exists on the new server
     * and force is false, this method will return the existing player. Otherwise, a new player
     * will be created and the current player will be destroyed.
     * @param {PlayerOptions} newOptions - The new options for the player.
     * @param {boolean} force - Whether to force the creation of a new player.
     * @returns {Promise<Player>} - The new player instance.
     */
    async switchGuild(newOptions, force = false) {
        if (newOptions.guildId === this.guildId) return this;
        if (!newOptions.guildId)
            throw new Error("guildId is required");
        if (!newOptions.voiceChannelId)
            throw new Error("Voice channel ID is required");
        if (!newOptions.textChannelId)
            throw new Error("Text channel ID is required");
        // Check if a player already exists for the new guild
        let newPlayer = this.manager.players.get(newOptions.guildId);
        // If the player already exists and force is false, return the existing player
        if (newPlayer && !force)
            return newPlayer;
        const oldPlayerProperties = {
            paused: this.paused,
            selfMute: this.options.selfMute,
            selfDeafen: this.options.selfDeafen,
            volume: this.volume,
            position: this.position,
            queue: {
                current: this.queue.current,
                tracks: [...this.queue],
                previous: [...this.queue.previous],
            },
            trackRepeat: this.trackRepeat,
            queueRepeat: this.queueRepeat,
            dynamicRepeat: this.dynamicRepeat,
            dynamicRepeatIntervalMs: this.dynamicRepeatIntervalMs,
            ClientUser: this.get("Internal_BotUser"),
            filters: this.filters,
            isAutoplay: this.isAutoplay,
        };
        // If force is true, destroy the existing player for the new guild
        if (force && newPlayer) {
            await newPlayer.destroy();
        }
        newOptions = { ...newOptions };
        newOptions.node = newOptions.node ?? this.node.options.identifier;
        newOptions.selfDeafen = newOptions.selfDeafen ?? oldPlayerProperties.selfDeafen;
        newOptions.selfMute = newOptions.selfMute ?? oldPlayerProperties.selfMute;
        newOptions.volume = newOptions.volume ?? oldPlayerProperties.volume;
        // Deep clone the current player
        const clonedPlayer = this.manager.create(newOptions);
        try {
            // Connect the cloned player to the new voice channel
            clonedPlayer.connect();
            // Update the player's state on the Lavalink node
            await clonedPlayer.node.rest.updatePlayer({
                guildId: clonedPlayer.guildId,
                data: {
                    paused: oldPlayerProperties.paused,
                    volume: oldPlayerProperties.volume,
                    position: oldPlayerProperties.position,
                    encodedTrack: oldPlayerProperties.queue.current?.track,
                },
            });
            clonedPlayer.queue.current = oldPlayerProperties.queue.current;
            clonedPlayer.queue.previous = oldPlayerProperties.queue.previous;
            clonedPlayer.queue.add(oldPlayerProperties.queue.tracks);
            clonedPlayer.filters.restore(oldPlayerProperties.filters.snapshot());
            clonedPlayer.isAutoplay = oldPlayerProperties.isAutoplay;
            clonedPlayer.trackRepeat = oldPlayerProperties.trackRepeat;
            clonedPlayer.queueRepeat = oldPlayerProperties.queueRepeat;
            if (oldPlayerProperties.dynamicRepeat && clonedPlayer.queue.size > 1) clonedPlayer.setDynamicRepeat(true, oldPlayerProperties.dynamicRepeatIntervalMs);
            if (oldPlayerProperties.isAutoplay && oldPlayerProperties.ClientUser) clonedPlayer.setAutoplay(true, oldPlayerProperties.ClientUser, this.autoplayTries);
            clonedPlayer.paused = oldPlayerProperties.paused;
            // Update filters for the cloned player
            await clonedPlayer.filters.updateFilters();
        } catch (error) {
            try { await clonedPlayer.destroy(); } catch (cleanupError) { clonedPlayer.node.error(cleanupError); }
            throw error;
        }
        // Debug information
        const debugInfo = {
            success: true,
            message: `Transferred ${clonedPlayer.queue.length} tracks successfully to <#${newOptions.voiceChannelId}> bound to <#${newOptions.textChannelId}>.`,
            player: {
                guildId: clonedPlayer.guildId,
                voiceChannelId: clonedPlayer.voiceChannelId,
                textChannelId: clonedPlayer.textChannelId,
                volume: clonedPlayer.volume,
                playing: clonedPlayer.playing,
                queueSize: clonedPlayer.queue.size,
            },
        };
        this.manager.emit(Manager_1.ManagerEventTypes.Debug, `[PLAYER] Transferred player to a new server: ${JSON.stringify(debugInfo)}.`);
        await this.destroy();
        return clonedPlayer;
    }
    /**
     * Retrieves the current lyrics for the playing track.
     * @param skipTrackSource - Indicates whether to skip the track source when fetching lyrics.
     * @returns {Promise<Lyrics>} - The lyrics of the current track.
     * @throws {RangeError} - If the 'lavalyrics-plugin' is not available on the Lavalink node.
     */
    async getCurrentLyrics(skipTrackSource = false) {
        if (!this.queue.current) {
            throw new RangeError("No current track to fetch lyrics for.");
        }
        // Check if the 'lavalyrics-plugin' is available on the node
        const hasLyricsPlugin = this.node.info?.plugins?.some((plugin) => plugin.name === "lavalyrics-plugin");
        if (!hasLyricsPlugin) {
            throw new RangeError(`There is no lavalyrics-plugin available in the Lavalink node: ${this.node.options.identifier}`);
        }
        // Fetch the lyrics for the current track from the Lavalink node
        let result = (await this.node.getLyrics(this.queue.current, skipTrackSource));
        // If no lyrics are found, return a default empty lyrics object
        if (!result) {
            result = {
                source: null,
                provider: null,
                text: null,
                lines: [],
                plugin: [],
            };
        }
        return result;
    }
}
exports.Player = Player;
