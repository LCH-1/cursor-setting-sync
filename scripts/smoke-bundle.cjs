"use strict";

// tsc type-checks source and vitest imports source directly, so neither loads
// the esbuild bundle. A dependency shipped as a UMD wrapper (e.g. jsonc-parser)
// can bundle into a module that does a runtime require of a path absent from
// dist, crashing the extension at load with every command "not found". This
// smoke check exercises each produced bundle so a broken bundle fails the build
// instead of shipping.

const Module = require("node:module");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const distRoot = join(__dirname, "..", "dist");
const LOAD_FAILURE = /Cannot find module|Unexpected token|SyntaxError|ERR_REQUIRE_ESM/;
let failed = false;

// The extension entry only exports activate(); requiring it runs the bundle's
// top level, which is exactly where the UMD-require crash surfaces. A vscode
// stub lets that module graph load without the editor host.
const vscodeStub = new Proxy(
  {},
  {
    get(target, property) {
      if (!(property in target)) {
        target[property] = () => vscodeStub;
      }
      return target[property];
    },
  },
);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  return request === "vscode" ? vscodeStub : originalLoad.call(this, request, ...rest);
};
try {
  require(join(distRoot, "extension.js"));
  process.stdout.write("smoke: extension.js loads\n");
} catch (error) {
  failed = true;
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`smoke: extension.js FAILED to load\n${message}\n`);
}

// The helper entry self-executes main() on load, so running it as a child and
// inspecting its output is the only way to prove the bundle loads: its
// no-arguments guard exits non-zero, which is expected — only a module-load
// error (not a runtime guard) is a smoke failure.
const helper = spawnSync(process.execPath, [join(distRoot, "helper.js")], {
  encoding: "utf8",
  timeout: 30_000,
});
const helperOutput = `${helper.stdout ?? ""}${helper.stderr ?? ""}`;
if (helper.error !== undefined || LOAD_FAILURE.test(helperOutput)) {
  failed = true;
  process.stderr.write(
    `smoke: helper.js FAILED to load\n${helper.error?.stack ?? helperOutput}\n`,
  );
} else {
  process.stdout.write("smoke: helper.js loads\n");
}

const inspector = spawnSync(process.execPath, ["-e", `
  const {Worker}=require("node:worker_threads");
  const worker=new Worker(process.argv[1],{workerData:process.argv[2]});
  const timer=setTimeout(()=>{worker.terminate();process.exitCode=1},10000);
  worker.once("message",value=>{
    clearTimeout(timer);
    if(typeof value.error!=="string"||${LOAD_FAILURE}.test(value.error))process.exitCode=1;
    worker.terminate();
  });
  worker.once("error",error=>{clearTimeout(timer);process.stderr.write(String(error));process.exitCode=1});
`, join(distRoot, "schema-inspector.js"), join(distRoot, "missing-app-fixture")], {
  encoding: "utf8", timeout: 15_000,
});
if (inspector.error !== undefined || inspector.status !== 0) {
  failed = true;
  process.stderr.write(`smoke: schema-inspector.js FAILED to load\n${inspector.error?.stack ?? inspector.stderr}\n`);
} else process.stdout.write("smoke: schema-inspector.js loads in a worker\n");

if (failed) {
  process.exitCode = 1;
}
