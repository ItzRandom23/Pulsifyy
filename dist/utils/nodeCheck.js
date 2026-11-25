"use strict";
const { isIP } = require("node:net");

function nodeCheck(options) {
    const { host, identifier, password, port, nodePriority } = options;
    const ipv6 = typeof host === "string" && host.startsWith("[") && host.endsWith("]") && isIP(host.slice(1, -1)) === 6;
    if (!ipv6 && (typeof host !== "string" || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9.])?$/i.test(host))) {
        throw new TypeError("Lavalink host must be a hostname, IPv4 address or bracketed IPv6 address.");
    }
    if (identifier !== undefined && (typeof identifier !== "string" || !identifier.trim() || identifier.length > 128 || /[\x00-\x1f\x7f]/.test(identifier))) {
        throw new TypeError("Invalid Lavalink node identifier.");
    }
    if (typeof password !== "string" || !password.trim() || /[^\x20-\x7e]/.test(password)) {
        throw new TypeError("A Lavalink node password is required.");
    }
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new RangeError("Invalid Lavalink port.");
    if (nodePriority !== undefined && (!Number.isFinite(nodePriority) || nodePriority < 0)) throw new RangeError("Invalid Lavalink node priority.");
    for (const key of ["enableSessionResumeOption", "useSSL"]) {
        if (options[key] !== undefined && typeof options[key] !== "boolean") throw new TypeError(key + " must be a boolean.");
    }
    for (const [key, minimum, maximum] of [
        ["sessionTimeoutMs", 1, 2147483647], ["apiRequestTimeoutMs", 1, 2147483647],
        ["retryDelayMs", 0, 60000], ["maxRetryAttempts", 0, 1000],
    ]) {
        const value = options[key];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) {
            throw new RangeError("Invalid Lavalink node option: " + key);
        }
    }
    try { new URL("http://" + host); }
    catch { throw new TypeError("Invalid Lavalink host."); }
}
exports.default = nodeCheck;
