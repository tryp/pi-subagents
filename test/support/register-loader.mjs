/**
 * Register the .js → .ts loader hook for integration tests.
 *
 * Usage: node --import ./test/support/register-loader.mjs --test test/integration/*.test.ts
 *
 * Handles one issue: source files use .js import extensions (TypeScript ESM
 * convention) but files on disk are .ts, so the loader rewrites .js -> .ts at
 * resolve time.
 *
 * Type stripping needs no flag: node enables it by default
 * (process.features.typescript === "strip"). This hook used to be documented as
 * requiring --experimental-transform-types for TypeScript parameter properties,
 * but no source file uses them and node 26 rejects that flag outright
 * ("bad option"), so every suite that passed it failed to start.
 */

import { register } from "node:module";

register(new URL("./ts-loader.mjs", import.meta.url));
