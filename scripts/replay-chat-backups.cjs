"use strict";
const { buildSync } = require("esbuild");
const Module = require("node:module");
const { join } = require("node:path");

const [fixtureRoot, outputRoot] = process.argv.slice(2);
if (!fixtureRoot) {
  process.stderr.write("Usage: node scripts/replay-chat-backups.cjs <fixture-directory> [output-directory]\n");
  process.exitCode = 1;
} else {
  const entry = join(__dirname, "replay-chat-backups.ts");
  const originalLoad = Module._load;
  Module._load = function(name, ...rest) {
    return name === "vscode" ? { extensions: { all: [] }, window: {} } : originalLoad.call(this, name, ...rest);
  };
  const output = buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs",
    target: "node24", mainFields: ["module", "main"], write: false, external: ["vscode"], logLevel: "silent" });
  const loaded = new Module(entry, module);
  loaded.filename = entry;
  loaded.paths = Module._nodeModulePaths(__dirname);
  loaded._compile(output.outputFiles[0].text, entry);
  Module._load = originalLoad;
  loaded.exports.replayChatBackups(fixtureRoot, outputRoot).then(result => {
    process.stdout.write(JSON.stringify({ complete: true, reportRoot: result.reportRoot }) + "\n");
  }).catch(error => {
    process.stderr.write((error instanceof Error ? error.stack : String(error)) + "\n");
    process.exitCode = 1;
  });
}
