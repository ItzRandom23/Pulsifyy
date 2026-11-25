"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrackSourceTypes = exports.SeverityTypes = exports.TrackEndReasonTypes = exports.StateTypes = exports.LoadTypes = exports.Structure = exports.AutoPlayUtils = exports.TrackUtils = void 0;
const tslib_1 = require("tslib");
const Manager_1 = require("./Manager");
const axios_1 = tslib_1.__importDefault(require("axios"));

class TrackUtils {
    static trackPartial = null;
    static manager;
    /**
     * Initializes the TrackUtils class with the given manager.
     * @param manager The manager instance to use.
     * @hidden
     */
    static init(manager) {
        // Set the manager instance for TrackUtils.
        this.manager = manager;
    }
    /**
     * Sets the partial properties for the Track class. If a Track has some of its properties removed by the partial,
     * it will be considered a partial Track.
     * @param {TrackPartial} partial The array of string property names to remove from the Track class.
     */
    static setTrackPartial(partial) {
        if (!Array.isArray(partial) || !partial.every((str) => typeof str === "string"))
            throw new Error("Provided partial is not an array or not a string array.");
        /** The array of property names to keep on each built track */
        this.trackPartial = Array.from(new Set(partial));
        /** Make sure that the "track" property is always included */
        if (!this.trackPartial.includes(Manager_1.TrackPartial.Track))
            this.trackPartial.unshift(Manager_1.TrackPartial.Track);
    }
    /**
     * Checks if the provided argument is a valid Track.
     * If provided an array then every element will be checked.
     * @param trackOrTracks The Track or array of Tracks to check.
     * @returns {boolean} Whether the provided argument is a valid Track.
     */
    static validate(trackOrTracks) {
        if (typeof trackOrTracks !== "object" || trackOrTracks === null) {
            return false;
        }
        const isValidTrack = (track) => {
            if (typeof track !== "object" || track === null) {
                return false;
            }
            const t = track;
            return typeof t.track === "string" && t.track.length > 0;
        };
        if (Array.isArray(trackOrTracks)) {
            return Array.from(trackOrTracks).every(isValidTrack);
        }
        return isValidTrack(trackOrTracks);
    }
    /**
     * Builds a Track from the raw data from Lavalink and a optional requester.
     * @param data The raw data from Lavalink to build the Track from.
     * @param requester The user who requested the track, if any.
     * @returns The built Track.
     */
    static build(data, requester, partial = this.trackPartial) {
        if (!data?.info || typeof data.encoded !== "string" || !data.encoded) throw new RangeError("Invalid Lavalink track.");
        try {
            const sourceNameMap = {
                applemusic: "AppleMusic",
                amazonmusic: "AmazonMusic",
                audiomack: "AudioMack",
                bandcamp: "Bandcamp",
                deezer: "Deezer",
                gaana: "Gaana",
                jiosaavn: "Jiosaavn",
                lastfm: "LastFM",
                soundcloud: "SoundCloud",
                spotify: "Spotify",
                tidal: "Tidal",
                vkmusic: "VKMusic",
                qobuz: "Qobuz",
                youtube: "YouTube",
            };
            const sourceName = data.info.sourceName?.toLowerCase();
            const track = {
                track: data.encoded,
                title: data.info.title,
                identifier: data.info.identifier,
                author: data.info.author,
                duration: data.info.length,
                isrc: data.info?.isrc,
                isSeekable: data.info.isSeekable,
                isStream: data.info.isStream,
                uri: data.info.uri,
                artworkUrl: data.info?.artworkUrl,
                sourceName: Object.hasOwn(sourceNameMap, sourceName) ? sourceNameMap[sourceName] : data.info.sourceName,
                thumbnail: data.info.artworkUrl ?? null,
                displayThumbnail() { return this.artworkUrl ?? this.thumbnail ?? null; },
                requester: requester,
                pluginInfo: data.pluginInfo,
                customData: {},
            };
            track.displayThumbnail = track.displayThumbnail.bind(track);
            if (partial) {
                for (const key of Object.keys(track)) {
                    if (key === "track" || key === "displayThumbnail" || partial.includes(key))
                        continue;
                    delete track[key];
                }
                Object.defineProperty(track, "displayThumbnail", { enumerable: false });
            }
            return track;
        }
        catch (error) {
            throw new RangeError(`Argument "data" is not a valid track: ${error.message}`);
        }
    }
}
exports.TrackUtils = TrackUtils;
const recommendationPrefixes = new Map([
    ["jiosaavn", "jsrec"], ["spotify", "sprec:mix:track"], ["deezer", "dzrec"],
    ["tidal", "tdrec"], ["vkmusic", "vkrec"],
]);

async function providerRequest(url, node, responseType) {
    const timeout = node?.options.apiRequestTimeoutMs ?? 10000;
    try {
        const response = await axios_1.default.get(url.href, {
            timeout, signal: AbortSignal.timeout(timeout), responseType,
            maxRedirects: 0, maxContentLength: 2 * 1024 * 1024, proxy: false,
        });
        return response.data;
    } catch {
        throw new Error("Recommendation provider request failed.");
    }
}

function soundCloudUrl(value) {
    if (typeof value !== "string") return null;
    try {
        const url = new URL(value);
        if (url.origin === "https://soundcloud.com" && !url.username && !url.password) return url;
    } catch { /* invalid or missing metadata */ }
    return null;
}

function descendants(element, tagName) {
    const result = [];
    const stack = [...(element.childNodes ?? [])].reverse();
    while (stack.length) {
        const next = stack.pop();
        if (next.tagName === tagName) result.push(next);
        for (let index = (next.childNodes?.length ?? 0) - 1; index >= 0; index--) stack.push(next.childNodes[index]);
    }
    return result;
}

class AutoPlayUtils {
    static managerRef;

    static init(manager) {
        if (!manager) throw new Error("AutoPlayUtils.init() requires a valid Manager instance.");
        this.managerRef = new WeakRef(manager);
    }

    static get manager() { return this.managerRef?.deref(); }

    static async getRecommendedTracks(track, manager = this.manager, node = manager?.useableNode, selectTracks = tracks => tracks) {
        if (!node) throw new Error("No available nodes.");
        const enabled = new Set(node.info?.sourceManagers?.map(source => source.toLowerCase()));
        for (const platform of manager.options.autoPlaySearchPlatforms) {
            if (!enabled.has(platform)) continue;
            try {
                const tracks = selectTracks(await this.getRecommendedTracksFromSource(track, platform, manager, node));
                if (tracks.length) return tracks;
            } catch { manager.log("warn", "A Lavalink recommendation source failed."); }
        }
        if (manager.options.lastFmApiKey) {
            try { return selectTracks(await this.getRecommendedTracksFromLastFm(track, manager.options.lastFmApiKey, manager, node)); }
            catch { manager.log("warn", "Last.fm recommendations failed."); }
        }
        return [];
    }

    static async getRecommendedTracksFromLastFm(track, apiKey, manager = this.manager, node = manager?.useableNode) {
        const request = (method, params) => {
            const url = new URL("https://ws.audioscrobbler.com/2.0/");
            url.search = new URLSearchParams({ method, api_key: apiKey, format: "json", limit: "10", ...params });
            return providerRequest(url, node, "json");
        };
        let { title, author: artist } = track;
        if (!artist && title) {
            const response = await request("track.search", { track: title });
            artist = response?.results?.trackmatches?.track?.[0]?.artist;
        }
        if (!artist) return [];
        let matches;
        if (title) {
            const response = await request("track.getSimilar", { artist, track: title, autocorrect: "1" });
            matches = response?.similartracks?.track;
        }
        if (!matches?.length) {
            const response = await request("artist.getTopTracks", { artist, autocorrect: "1" });
            matches = response?.toptracks?.track;
        }
        if (!Array.isArray(matches) || !matches.length) return [];
        const next = matches[Math.floor(Math.random() * matches.length)];
        if (!next?.artist?.name || !next.name) return [];
        const result = await manager.searchOnNode(node, next.artist.name + " - " + next.name, track.requester);
        return result.tracks.filter(candidate => candidate.track !== track.track);
    }

    static async getRecommendedTracksFromSource(track, platform, manager = this.manager, node = manager?.useableNode) {
        if (!node || (!recommendationPrefixes.has(platform) && platform !== "soundcloud")) return [];
        const matchesSource = platform === "soundcloud"
            ? soundCloudUrl(track.uri)
            : typeof track.identifier === "string" && track.sourceName?.toLowerCase() === platform;
        if (!matchesSource) {
            if (!track.title && !track.author) return [];
            const result = await manager.searchOnNode(node, [track.title, track.author].filter(Boolean).join(" "), track.requester, [platform]);
            track = result.tracks[0];
            if (!track) return [];
        }
        if (platform === "soundcloud") {
            const url = soundCloudUrl(track.uri);
            if (!url) return [];
            url.pathname = url.pathname.replace(/\/$/, "") + "/recommended";
            url.search = "";
            url.hash = "";
            const { parse } = require("parse5");
            const document = parse(await providerRequest(url, node, "text"), { scriptingEnabled: false });
            const urls = [];
            for (const section of descendants(document, "noscript")) {
                for (const link of descendants(section, "a")) {
                    if (!link.attrs.some(attribute => attribute.name === "itemprop" && attribute.value === "url")) continue;
                    const href = link.attrs.find(attribute => attribute.name === "href")?.value;
                    if (!href?.startsWith("/")) continue;
                    const candidate = soundCloudUrl(new URL(href, url.origin).href);
                    if (candidate) urls.push(candidate.href);
                }
            }
            if (!urls.length) return [];
            return (await manager.searchOnNode(node, urls[Math.floor(Math.random() * urls.length)], track.requester)).tracks;
        }
        if (typeof track.identifier !== "string" || !track.identifier) return [];
        const identifier = recommendationPrefixes.get(platform) + ":" + track.identifier;
        const result = await node.rest.get("/v4/loadtracks?identifier=" + encodeURIComponent(identifier));
        let tracks;
        switch (result?.loadType) {
            case LoadTypes.Track: tracks = [result.data]; break;
            case LoadTypes.Search: tracks = result.data; break;
            case LoadTypes.Playlist: tracks = result.data?.tracks; break;
            default: return [];
        }
        if (!Array.isArray(tracks)) return [];
        return tracks.slice(0, 100).map(item => TrackUtils.build(item, track.requester, manager.options.trackPartial ?? null));
    }
}
exports.AutoPlayUtils = AutoPlayUtils;
/** Gets or extends structures to extend the built in, or already extended, classes to add more functionality. */
class Structure {
    static create(name, options, manager) {
        const Class = this.get(name);
        const previous = this.constructingManager;
        this.constructingManager = manager;
        try { return new Class(options, manager); }
        finally { this.constructingManager = previous; }
    }

    /**
     * Extends a class.
     * @param name
     * @param extender
     */
    static extend(name, extender) {
        const extended = extender(this.get(name));
        if (typeof extended !== "function") throw new TypeError("A structure extension must return a class.");
        structures.set(name, extended);
        return extended;
    }
    /**
     * Get a structure from available structures by name.
     * @param name
     */
    static get(name) {
        const structure = structures.get(name) ?? structureLoaders.get(name)?.();
        if (!structure)
            throw new TypeError('"structure" must be provided.');
        return structure;
    }
}
exports.Structure = Structure;
const structureLoaders = new Map([
    ["Player", () => require("./Player").Player],
    ["Queue", () => require("./Queue").Queue],
    ["Node", () => require("./Node").Node],
    ["Filters", () => require("./Filters").Filters],
    ["Manager", () => require("./Manager").Manager],
    ["Plugin", () => require("./Plugin").Plugin],
    ["Rest", () => require("./Rest").Rest],
    ["Utils", () => module.exports],
]);
const structures = new Map();
var LoadTypes;
(function (LoadTypes) {
    LoadTypes["Track"] = "track";
    LoadTypes["Playlist"] = "playlist";
    LoadTypes["Search"] = "search";
    LoadTypes["Empty"] = "empty";
    LoadTypes["Error"] = "error";
})(LoadTypes || (exports.LoadTypes = LoadTypes = {}));
var StateTypes;
(function (StateTypes) {
    StateTypes["Connected"] = "CONNECTED";
    StateTypes["Connecting"] = "CONNECTING";
    StateTypes["Disconnected"] = "DISCONNECTED";
    StateTypes["Disconnecting"] = "DISCONNECTING";
    StateTypes["Destroying"] = "DESTROYING";
})(StateTypes || (exports.StateTypes = StateTypes = {}));
var TrackEndReasonTypes;
(function (TrackEndReasonTypes) {
    TrackEndReasonTypes["Finished"] = "finished";
    TrackEndReasonTypes["LoadFailed"] = "loadFailed";
    TrackEndReasonTypes["Stopped"] = "stopped";
    TrackEndReasonTypes["Replaced"] = "replaced";
    TrackEndReasonTypes["Cleanup"] = "cleanup";
})(TrackEndReasonTypes || (exports.TrackEndReasonTypes = TrackEndReasonTypes = {}));
var SeverityTypes;
(function (SeverityTypes) {
    SeverityTypes["Common"] = "common";
    SeverityTypes["Suspicious"] = "suspicious";
    SeverityTypes["Fault"] = "fault";
})(SeverityTypes || (exports.SeverityTypes = SeverityTypes = {}));
var TrackSourceTypes;
(function (TrackSourceTypes) {
    TrackSourceTypes["AppleMusic"] = "applemusic";
    TrackSourceTypes["AmazonMusic"] = "amazonmusic";
    TrackSourceTypes["AudioMack"] = "audiomack";
    TrackSourceTypes["Bandcamp"] = "bandcamp";
    TrackSourceTypes["Deezer"] = "deezer";
    TrackSourceTypes["Gaana"] = "gaana";
    TrackSourceTypes["Jiosaavn"] = "jiosaavn";
    TrackSourceTypes["Qobuz"] = "qobuz";
    TrackSourceTypes["SoundCloud"] = "soundcloud";
    TrackSourceTypes["Spotify"] = "spotify";
    TrackSourceTypes["Tidal"] = "tidal";
    TrackSourceTypes["VKMusic"] = "vkmusic";
    TrackSourceTypes["YouTube"] = "youtube";
})(TrackSourceTypes || (exports.TrackSourceTypes = TrackSourceTypes = {}));
