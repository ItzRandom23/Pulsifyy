"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Queue = void 0;
const Manager_1 = require("./Manager");
const Utils_1 = require("./Utils");

function shuffleItems(items) {
    for (let index = items.length - 1; index > 0; index--) {
        const other = Math.floor(Math.random() * (index + 1));
        [items[index], items[other]] = [items[other], items[index]];
    }
    return items;
}

/**
 * The player's queue, the `current` property is the currently playing track, think of the rest as the up-coming tracks.
 */
class Queue extends Array {
    static get [Symbol.species]() { return Array; }

    /**
     * The total duration of the queue in milliseconds.
     * This includes the duration of the currently playing track.
     */
    get duration() {
        // Get the duration of the currently playing track, or 0 if there is none.
        const current = this.current?.duration ?? 0;
        // Return the sum of all durations in the queue including the current track.
        return this.reduce((acc, cur) => acc + (cur.duration || 0), current);
    }
    /**
     * The total size of tracks in the queue including the current track.
     * This includes the current track if it is not null.
     * @returns The total size of tracks in the queue including the current track.
     */
    get totalSize() {
        return this.length + (this.current ? 1 : 0);
    }
    /**
     * The size of tracks in the queue.
     * This does not include the currently playing track.
     * @returns The size of tracks in the queue.
     */
    get size() {
        return this.length;
    }
    /** The current track */
    current = null;
    /** The previous tracks */
    previous = [];
    /** The Manager instance. */
    manager;
    /** The guild ID property. */
    guildId;
    /**
     * Constructs a new Queue.
     * @param guildId The guild ID.
     * @param manager The Manager instance.
     */
    constructor(guildId, manager) {
        super();
        /** The Manager instance. */
        this.manager = manager;
        /** The guild property. */
        this.guildId = guildId;
    }
    /**
     * Adds a track to the queue.
     * @param track The track or tracks to add. Can be a single `Track` or an array of `Track`s.
     * @param [offset=null] The position to add the track(s) at. If not provided, the track(s) will be added at the end of the queue.
     */
    add(track, offset) {
        const tracks = Array.isArray(track) ? [...track] : [track];
        if (!tracks.length) return;
        if (!Utils_1.TrackUtils.validate(tracks)) throw new TypeError("Invalid queue track.");
        const player = this.manager.players.get(this.guildId);
        if (player?.destroyRequested) throw new Error("Player has been destroyed.");
        if (this.totalSize + tracks.length > this.manager.options.maxQueueSize) throw new RangeError("Queue limit exceeded.");
        if (offset !== undefined && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > this.length)) {
            throw new RangeError("Offset must be an integer within the upcoming queue.");
        }
        const oldPlayer = player ? { ...player } : null;
        const current = this.current ? null : tracks[0];
        const upcoming = current ? tracks.slice(1) : tracks;
        if (current) this.current = current;
        if (offset === undefined || offset === this.length) {
            for (const next of upcoming) this.push(next);
        } else {
            const tail = this.splice(offset);
            for (const next of upcoming) this.push(next);
            for (const next of tail) this.push(next);
        }
        if (player) player.lastActivityAt = Date.now();
        if (player?.isAutoplay) {
            const manual = tracks.findLast(next => !player.isAutoplayTrack(next));
            if (manual) player.lastUserRequestedTrackId = manual.identifier ?? null;
        }
        const changeType = player?.isAutoplay && !Array.isArray(track) && player.isAutoplayTrack(track) ? "autoPlayAdd" : "add";
        this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, player, {
            changeType: Manager_1.PlayerStateEventTypes.QueueChange, details: { changeType, tracks },
        });
    }
    remove(startOrPosition = 0, end) {
        if (!Number.isSafeInteger(startOrPosition) || (end !== undefined &&
            (!Number.isSafeInteger(end) || startOrPosition < 0 || startOrPosition >= end || end > this.length))) {
            throw new RangeError("Invalid queue removal range.");
        }
        const player = this.manager.players.get(this.guildId);
        const oldPlayer = player ? { ...player } : null;
        const tracks = this.splice(startOrPosition, end === undefined ? 1 : end - startOrPosition);
        if (tracks.length) {
            this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, player, {
                changeType: Manager_1.PlayerStateEventTypes.QueueChange, details: { changeType: "remove", tracks },
            });
        }
        return tracks;
    }
    /**
     * Clears the queue.
     * This will remove all tracks from the queue and emit a state update event.
     */
    clear() {
        // Capture the current state of the player for event emission.
        const oldPlayer = this.manager.players.get(this.guildId) ? { ...this.manager.players.get(this.guildId) } : null;
        // Remove all items from the queue.
        this.splice(0);
        // Emit an event to update the player state indicating the queue has been cleared.
        this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this.manager.players.get(this.guildId), {
            changeType: Manager_1.PlayerStateEventTypes.QueueChange,
            details: {
                changeType: "clear",
                tracks: [], // No tracks are left after clearing
            },
        });
        // Emit a debug message indicating the queue has been cleared for a specific guild ID.
        this.manager.emit(Manager_1.ManagerEventTypes.Debug, `[QUEUE] Cleared the queue for: ${this.guildId}`);
    }
    /**
     * Shuffles the queue.
     * This will randomize the order of the tracks in the queue and emit a state update event.
     */
    shuffle() {
        // Capture the current state of the player for event emission.
        const oldPlayer = this.manager.players.get(this.guildId) ? { ...this.manager.players.get(this.guildId) } : null;
        // Shuffle the queue.
        shuffleItems(this);
        // Emit an event to update the player state indicating the queue has been shuffled.
        this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this.manager.players.get(this.guildId), {
            changeType: Manager_1.PlayerStateEventTypes.QueueChange,
            details: {
                changeType: "shuffle",
            },
        });
        // Emit a debug message indicating the queue has been shuffled for a specific guild ID.
        this.manager.emit(Manager_1.ManagerEventTypes.Debug, `[QUEUE] Shuffled the queue for: ${this.guildId}`);
    }
    /**
     * Shuffles the queue to play tracks requested by each user one block at a time.
     */
    userBlockShuffle() {
        this.shuffleByRequester(false);
    }

    roundRobinShuffle() {
        this.shuffleByRequester(true);
    }

    shuffleByRequester(randomize) {
        const player = this.manager.players.get(this.guildId);
        const oldPlayer = player ? { ...player } : null;
        const groups = new Map();
        for (const track of this) {
            const id = track?.requester?.id;
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(track);
        }
        const blocks = [...groups.values()];
        let index = 0;
        if (randomize) {
            // Advance each group's cursor once per round.
            let active = blocks.map(tracks => ({ tracks: shuffleItems(tracks), cursor: 0 }));
            while (active.length) {
                const next = [];
                for (const group of active) {
                    this[index++] = group.tracks[group.cursor++];
                    if (group.cursor < group.tracks.length) next.push(group);
                }
                active = next;
            }
        } else {
            for (const tracks of shuffleItems(blocks)) {
                for (const track of tracks) this[index++] = track;
            }
        }
        this.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, player, {
            changeType: Manager_1.PlayerStateEventTypes.QueueChange,
            details: { changeType: randomize ? "roundRobin" : "userBlock" },
        });
    }
}
exports.Queue = Queue;
