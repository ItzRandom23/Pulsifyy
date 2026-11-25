"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = managerCheck;
const Manager_1 = require("../structures/Manager");
/**
 * Validates the provided ManagerOptions object.
 * @param options - The options to validate.
 * @throws {TypeError} Throws if any required option is missing or invalid.
 */
function managerCheck(options) {
    if (!options)
        throw new TypeError("ManagerOptions must not be empty.");
    const { playNextOnEnd, clientName, defaultSearchPlatform, autoPlaySearchPlatforms, nodes, enabledPlugins, send, trackPartial, enablePriorityMode, useNode, lastFmApiKey, } = options;
    // Validate playNextOnEnd option
    if (typeof playNextOnEnd !== "undefined" && typeof playNextOnEnd !== "boolean") {
        throw new TypeError('Manager option "playNextOnEnd" must be a boolean.');
    }
    // Validate clientName option
    if (typeof clientName !== "undefined") {
        if (typeof clientName !== "string" || clientName.trim().length === 0 || /[^\x20-\x7e]/.test(clientName)) {
            throw new TypeError('Manager option "clientName" must be a non-empty string.');
        }
    }
    // Validate defaultSearchPlatform option
    if (typeof defaultSearchPlatform !== "undefined") {
        if (!Object.values(Manager_1.SearchPlatform).includes(defaultSearchPlatform)) {
            throw new TypeError(`Manager option "defaultSearchPlatform" must be one of: ${Object.values(Manager_1.SearchPlatform).join(", ")}.`);
        }
    }
    // Validate autoPlaySearchPlatforms
    if (typeof autoPlaySearchPlatforms !== "undefined") {
        if (!Array.isArray(autoPlaySearchPlatforms)) {
            throw new TypeError('Manager option "autoPlaySearchPlatforms" must be an array.');
        }
        if (!autoPlaySearchPlatforms.every((platform) => Object.values(Manager_1.AutoPlayPlatform).includes(platform))) {
            throw new TypeError(`Manager option "autoPlaySearchPlatforms" must be an array of valid AutoPlayPlatform values.`);
        }
    }
    // Validate nodes option
    if (typeof nodes !== "undefined" && !Array.isArray(nodes)) {
        throw new TypeError('Manager option "nodes" must be an array.');
    }
    // Validate enabledPlugins option
    if (typeof enabledPlugins !== "undefined" && !Array.isArray(enabledPlugins)) {
        throw new TypeError('Manager option "enabledPlugins" must be a Plugin array.');
    }
    // Validate send option
    if (typeof send !== "function") {
        throw new TypeError('Manager option "send" must be present and a function.');
    }
    // Validate trackPartial option
    if (typeof trackPartial !== "undefined") {
        if (!Array.isArray(trackPartial)) {
            throw new TypeError('Manager option "trackPartial" must be an array.');
        }
        if (!trackPartial.every((item) => Object.values(Manager_1.TrackPartial).includes(item))) {
            throw new TypeError('Manager option "trackPartial" must be an array of valid TrackPartial values.');
        }
    }
    // Validate enablePriorityMode option
    if (typeof enablePriorityMode !== "undefined" && typeof enablePriorityMode !== "boolean") {
        throw new TypeError('Manager option "enablePriorityMode" must be a boolean.');
    }
    // Validate node priority if enablePriorityMode is enabled
    if (enablePriorityMode && Array.isArray(nodes)) {
        for (let index = 0; index < nodes.length; index++) {
            if (!Number.isFinite(nodes[index]?.nodePriority)) {
                throw new TypeError(`Missing or invalid node option "nodePriority" at position ${index}`);
            }
        }
    }
    // Validate useNode option
    if (typeof useNode !== "undefined") {
        if (typeof useNode !== "string") {
            throw new TypeError('Manager option "useNode" must be a string "leastLoad" or "leastPlayers".');
        }
        if (!Object.values(Manager_1.UseNodeOptions).includes(useNode)) {
            throw new TypeError('Manager option "useNode" must be either "leastLoad" or "leastPlayers".');
        }
    }
    // Validate lastFmApiKey option
    if (typeof lastFmApiKey !== "undefined" && (typeof lastFmApiKey !== "string" || lastFmApiKey.trim().length === 0)) {
        throw new TypeError('Manager option "lastFmApiKey" must be a non-empty string.');
    }
    for (const [key, minimum, maximum] of [
        ["maxPreviousTracks", 1, 10000], ["maxQueueSize", 1, 100000],
        ["playerInactivityTimeoutMs", 0, 2147483647], ["trackCacheTtlMs", 0, 2147483647],
        ["trackCacheMaxEntries", 0, 10000], ["trackRetryAttempts", 0, 10],
    ]) {
        const value = options[key];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) throw new RangeError("Invalid manager option: " + key);
    }
    if (options.sessionDataPath !== undefined && (typeof options.sessionDataPath !== "string" || !options.sessionDataPath.trim())) {
        throw new TypeError("sessionDataPath must be a non-empty path.");
    }
    if (options.trackErrorRecovery !== undefined && typeof options.trackErrorRecovery !== "function") throw new TypeError("trackErrorRecovery must be a function.");
    if (options.logLevel !== undefined && !["error", "warn", "info", "debug"].includes(options.logLevel)) throw new TypeError("Invalid logLevel.");
}
