"use strict";

const { buildSync } = require("esbuild");
const Module = require("node:module");
const { join } = require("node:path");

const entry = join(__dirname, "probe-chat-recovery.ts");
const result = buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  write: false,
  logLevel: "silent",
});
const output = result.outputFiles && result.outputFiles[0];
if (!output) {
  process.stderr.write('{"error":"The recovery probe could not be built."}\n');
  process.exitCode = 1;
} else {
  const loaded = new Module(entry, module);
  loaded.filename = entry;
  loaded.paths = Module._nodeModulePaths(__dirname);
  loaded._compile(output.text, entry);
}
