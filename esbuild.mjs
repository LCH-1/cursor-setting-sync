import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: {
    extension: "src/extension.ts",
    helper: "src/helper/main.ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outdir: "dist",
  external: ["vscode"],
  // Prefer each dependency's ESM build. jsonc-parser's "main" is a UMD wrapper
  // that does runtime require("./impl/format") against paths that do not exist
  // inside the bundle, which crashes the whole extension at load; its "module"
  // build uses static imports that bundle correctly.
  mainFields: ["module", "main"],
  sourcemap: true,
  sourcesContent: false,
  logLevel: "info",
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
