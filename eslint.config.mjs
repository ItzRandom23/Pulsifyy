const globals = Object.fromEntries([
  "AbortSignal", "ArrayBuffer", "Buffer", "URL", "URLSearchParams", "clearInterval",
  "clearTimeout", "console", "fetch", "process", "setImmediate", "setInterval",
  "setTimeout", "structuredClone", "__dirname", "__filename",
].map(name => [name, "readonly"]));

export default [
  { ignores: ["node_modules/**", "pulsify/**", "magmastream/**", ".release-smoke/**", "release/**"] },
  { files: ["**/*.js", "**/*.cjs"], languageOptions: { sourceType: "commonjs" } },
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    languageOptions: { globals },
    rules: {
      "no-undef": "error",
      "no-unreachable": "error",
      "no-duplicate-case": "error",
      "no-dupe-keys": "error",
      "no-async-promise-executor": "error",
      "no-unsafe-finally": "error",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
    },
  },
];
