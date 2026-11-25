"use strict";
const axios = require("axios");
const Manager_1 = require("./Manager");

const MAX_CONTENT_BYTES = 8 * 1024 * 1024;

class LavalinkRequestError extends Error {
    constructor(method, status) {
        super(status ? `Lavalink ${method} failed (HTTP ${status}).` : `Lavalink ${method} failed or returned an invalid response.`);
        this.name = "LavalinkRequestError";
        this.status = status;
    }
}

class Rest {
    #password;
    #pendingLoads = new Map();
    #activeRequests = 0;

    constructor(node, manager) {
        this.node = node;
        this.manager = manager;
        this.url = new URL((node.options.useSSL ? "https://" : "http://") + node.address).origin;
        this.#password = node.options.password;
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
        return sessionId;
    }

    sessionPath(guildId) {
        const sessionId = this.node.sessionId;
        if (!sessionId) throw new Error("Lavalink session is not ready.");
        const base = `/v4/sessions/${encodeURIComponent(sessionId)}`;
        if (guildId === undefined) return base;
        if (typeof guildId !== "string" || !/^\d+$/.test(guildId)) throw new TypeError("Invalid Discord guild ID.");
        return `${base}/players/${guildId}`;
    }

    async getAllPlayers() {
        return this.get(`${this.sessionPath()}/players`);
    }

    async updatePlayer(options) {
        const { noReplace: legacyNoReplace, encodedTrack, identifier, startTime, ...data } = options.data;
        if (encodedTrack !== undefined && !Object.hasOwn(data, "track")) {
            data.track = { encoded: encodedTrack };
        } else if (identifier !== undefined && !Object.hasOwn(data, "track")) {
            data.track = { identifier };
        }
        if (startTime !== undefined && data.position === undefined) data.position = startTime;
        const noReplace = options.noReplace ?? legacyNoReplace ?? false;
        if (typeof noReplace !== "boolean") throw new TypeError("noReplace must be a boolean.");
        const response = await this.patch(this.sessionPath(options.guildId) + "?noReplace=" + noReplace, data);
        if (!response || response.guildId !== options.guildId || !Object.hasOwn(response, "track")) {
            throw new LavalinkRequestError("PATCH");
        }
        return response;
    }

    async destroyPlayer(guildId) {
        if (!this.node.sessionId) return;
        try {
            await this.delete(this.sessionPath(guildId));
        } catch (error) {
            if (error.status !== 404) throw error;
        }
    }

    async updateSession(resuming, timeout) {
        return this.patch(this.sessionPath(), { resuming, timeout });
    }

    async request(method, endpoint, body) {
        if (typeof endpoint !== "string" || !/^\/(?!\/)/.test(endpoint) || /[\\\x00-\x20]/.test(endpoint)) {
            throw new TypeError("Lavalink endpoints must be relative paths on the configured node.");
        }
        const target = new URL(endpoint, this.url);
        if (target.origin !== this.url || target.hash) throw new TypeError("Invalid Lavalink endpoint.");
        const cache = this.manager.trackCache;
        const ttl = this.manager.options.trackCacheTtlMs;
        const limit = this.manager.options.trackCacheMaxEntries;
        if (method !== "GET" || target.pathname !== "/v4/loadtracks" || !ttl || !limit) {
            return this.send(method, target, body);
        }
        const key = JSON.stringify([this.node.options.identifier, target.search]);
        const cached = cache.get(key);
        if (cached) {
            cache.delete(key);
            if (cached.expiresAt > Date.now()) {
                cache.set(key, cached);
                return structuredClone(cached.value);
            }
        }
        let pending = this.#pendingLoads.get(key);
        if (!pending) {
            if (this.#pendingLoads.size >= limit) throw new Error("Too many pending Lavalink track loads.");
            pending = this.send(method, target, body).then(value => {
                const cacheable = value?.loadType === "empty" ||
                    (value?.loadType === "track" && typeof value.data?.encoded === "string") ||
                    (value?.loadType === "search" && Array.isArray(value.data) && value.data.length <= 100);
                if (!this.node.destroyed && cacheable && target.search.length < 8192 && JSON.stringify(value).length <= 131072) {
                    while (cache.size >= limit) cache.delete(cache.keys().next().value);
                    cache.set(key, { value, expiresAt: Date.now() + ttl });
                }
                return value;
            }).finally(() => this.#pendingLoads.delete(key));
            this.#pendingLoads.set(key, pending);
        }
        return structuredClone(await pending);
    }

    async send(method, target, body) {
        if (this.#activeRequests >= 256) throw new Error("Too many pending Lavalink requests on this node.");
        this.manager.emit(Manager_1.ManagerEventTypes.Debug, `[REST] ${method} on node ${this.node.options.identifier}`);
        this.#activeRequests++;
        try {
            const response = await axios({
                method,
                url: target.href,
                headers: { "Content-Type": "application/json", Authorization: this.#password },
                data: body,
                timeout: this.node.options.apiRequestTimeoutMs,
                maxRedirects: 0,
                maxContentLength: MAX_CONTENT_BYTES,
                maxBodyLength: MAX_CONTENT_BYTES,
                proxy: false,
                responseType: "json",
                transitional: { silentJSONParsing: false },
                signal: AbortSignal.timeout(this.node.options.apiRequestTimeoutMs),
            });
            return response.status === 204 ? null : response.data;
        } catch (error) {
            // Axios errors retain the authorization header, request body and response.
            const status = error.response?.status;
            if (status === 404 && error.response?.data?.message === "Session not found") {
                const match = /^\/v4\/sessions\/([^/]+)/.exec(target.pathname);
                if (match) this.node.invalidateSession(match[1]);
            }
            throw new LavalinkRequestError(method, status >= 300 ? status : undefined);
        } finally {
            this.#activeRequests--;
        }
    }

    get(endpoint) { return this.request("GET", endpoint); }
    patch(endpoint, body) { return this.request("PATCH", endpoint, body); }
    post(endpoint, body) { return this.request("POST", endpoint, body); }
    put(endpoint, body) { return this.request("PUT", endpoint, body); }
    delete(endpoint) { return this.request("DELETE", endpoint); }
}

exports.Rest = Rest;
