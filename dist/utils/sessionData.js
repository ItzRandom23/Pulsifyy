"use strict";
const fs = require("fs");
const path = require("path");
const current = path.join(process.cwd(), "pulsify");
const legacy = path.join(process.cwd(), "magmastream");
// Reuse the previous data directory on upgrade without moving user files.
exports.dataRoot = fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy;

exports.scopePath = function scopePath(manager) {
    const root = manager.options.sessionDataPath ?? exports.dataRoot;
    const client = manager.options.clientId;
    const cluster = manager.options.clusterId ?? 0;
    if (typeof client !== "string" || !/^\d+$/.test(client) || !Number.isSafeInteger(cluster) || cluster < 0) {
        throw new Error("Initialize the manager before accessing session data.");
    }
    return path.resolve(root, "sessions", client, String(cluster));
};
