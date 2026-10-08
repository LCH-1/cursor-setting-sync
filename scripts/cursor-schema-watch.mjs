import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const bundleRelative = "out/vs/workbench/workbench.desktop.main.js";
const options = parseArgs(process.argv.slice(2));
await mkdir(options.outdir, { recursive: true });
const corePath = join(options.outdir, `schema-inspector-${process.pid}.mjs`);
const built = await build({
  entryPoints: [join(root, "src/monitor/cursorSchema.ts")],
  bundle: true, write: false, platform: "node", format: "esm", packages: "external",
});
await writeFile(corePath, built.outputFiles[0].text);
let core;
try { core = await import(pathToFileURL(corePath).href); }
finally { await unlink(corePath); }

if (options.writeBaseline && !options.appRoot) {
  throw new Error("Baseline updates require an explicitly inspected --app-root; scheduled checks never approve changes.");
}
const baseline = options.writeBaseline ? null : JSON.parse(await readFile(options.baseline, "utf8"));
if (baseline !== null) core.validateCursorSnapshot(baseline);
const extracted = new Map();
for (const track of options.appRoot ? ["installed"] : options.tracks) {
  const reportPath = join(options.outdir, track);
  await mkdir(reportPath, { recursive: true });
  let report;
  try {
    const release = options.appRoot ? null : await fetchRelease(track);
    const appRoot = options.appRoot ?? await downloadAndExtract(release, options.outdir, extracted);
    const product = JSON.parse(await readFile(join(appRoot, "product.json"), "utf8"));
    if (typeof product.version !== "string" || !/^\d+\.\d+\.\d+/.test(product.version)) throw new Error("Cursor product version is unavailable");
    if (release !== null && product.version !== release.version) throw new Error("Downloaded Cursor version does not match release metadata");
    const bundlePath = join(appRoot, bundleRelative);
    if ((await stat(bundlePath)).size > 256 * 1024 * 1024) throw new Error("Cursor bundle exceeds 256 MiB inspection limit");
    const source = await readFile(bundlePath, "utf8");
    const snapshot = core.extractCursorSchema(source);
    core.validateCursorSnapshot(snapshot);
    const gaps = core.findCursorSchemaGaps(snapshot);
    const changes = baseline === null ? [] : core.compareCursorSchemas(baseline, snapshot);
    const observed = {
      ...snapshot, cursorVersion: product.version, vscodeVersion: product.vscodeVersion ?? "unknown",
      commit: release?.commitSha ?? product.commit ?? "unknown", observedAt: new Date().toISOString(),
    };
    await writeFile(join(reportPath, "observed-schema.json"), JSON.stringify(observed, null, 2) + "\n");
    if (options.writeBaseline) await writeFile(options.baseline, JSON.stringify(observed, null, 2) + "\n");
    report = {
      track, version: product.version, commit: observed.commit,
      baselineVersion: baseline?.cursorVersion ?? null,
      outcome: changes.length ? "changed" : gaps.length ? "unsupported" : "unchanged",
      baselineUpdated: options.writeBaseline, changes, unsupportedFields: gaps,
      note: "Static descriptor inspection only. Unchanged schema does not prove database health, backup completeness, or end-to-end continuation.",
    };
  } catch (error) {
    report = { track, outcome: "inspection-failed", error: error instanceof Error ? error.message : String(error) };
  }
  await writeFile(join(reportPath, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const markdown = renderReport(report);
  await writeFile(join(reportPath, "report.md"), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
  console.log(markdown);
  if (report.outcome !== "unchanged" && !options.writeBaseline) process.exitCode = 1;
  if (report.outcome === "inspection-failed") process.exitCode = 1;
}

function parseArgs(args) {
  const result = { outdir: join(root, "tmp/cursor-schema-watch"), baseline: join(root, "scripts/cursor-schema-baseline.json"), tracks: [], writeBaseline: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--write-baseline") { result.writeBaseline = true; continue; }
    if (!["--app-root", "--outdir", "--baseline", "--track"].includes(flag) || !args[index + 1]) throw new Error(`Unknown or incomplete option ${flag}`);
    const value = args[++index];
    if (flag === "--track") {
      if (!["stable", "latest"].includes(value)) throw new Error("Supported official release tracks: stable, latest");
      if (!result.tracks.includes(value)) result.tracks.push(value);
    } else result[{ "--app-root": "appRoot", "--outdir": "outdir", "--baseline": "baseline" }[flag]] = resolve(value);
  }
  if (!result.tracks.length) result.tracks = ["stable", "latest"];
  if (result.appRoot && args.includes("--track")) throw new Error("Use either --app-root or --track");
  return result;
}

async function request(url) {
  let failure;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: "follow" });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status} for ${new URL(url).hostname}`); }
      return response;
    } catch (error) { failure = error; }
  }
  throw failure;
}

async function fetchRelease(track) {
  const response = await request(`https://www.cursor.com/api/download?platform=linux-x64&releaseTrack=${track}`);
  const release = await response.json();
  if (typeof release.version !== "string" || !/^\d+\.\d+\.\d+$/.test(release.version) ||
    typeof release.commitSha !== "string" || !/^[a-f0-9]{40}$/.test(release.commitSha) ||
    typeof release.downloadUrl !== "string") throw new Error("Invalid Cursor release metadata");
  const url = new URL(release.downloadUrl);
  if (url.protocol !== "https:" || url.hostname !== "downloads.cursor.com" ||
    !url.pathname.endsWith(".AppImage") || url.username || url.password) throw new Error("Unexpected Cursor download origin or archive type");
  return release;
}

async function downloadAndExtract(release, outdir, cache) {
  if (process.platform !== "linux") throw new Error("Automatic archive inspection requires Linux with unsquashfs. Use --app-root for an installed Cursor on Windows/macOS.");
  const key = `${release.version}-${release.commitSha}`;
  if (cache.has(key)) return cache.get(key);
  const target = join(outdir, "downloads", key);
  await mkdir(target, { recursive: true });
  const archive = join(target, "Cursor.AppImage");
  const response = await request(release.downloadUrl);
  if (!response.body) throw new Error("Cursor archive response has no body");
  let bytes = 0;
  const maxBytes = 1024 * 1024 * 1024;
  const stream = Readable.fromWeb(response.body);
  stream.on("data", (chunk) => { bytes += chunk.length; if (bytes > maxBytes) stream.destroy(new Error("Cursor archive exceeds 1 GiB inspection limit")); });
  await pipeline(stream, createWriteStream(archive));
  await chmod(archive, 0o600);
  const offset = await core.findSquashfsOffset(archive);
  const destination = join(target, "extracted");
  const relativeRoot = "usr/share/cursor/resources/app";
  const unpack = spawnSync("unsquashfs", ["-no-progress", "-no-xattrs", "-f", "-processors", "2", "-o", String(offset), "-d", destination, archive,
    `${relativeRoot}/product.json`, `${relativeRoot}/${bundleRelative}`], { encoding: "utf8", timeout: 120_000 });
  if (unpack.error || unpack.status !== 0) throw new Error(`Cursor archive extraction failed: ${unpack.error?.message ?? unpack.stderr?.slice(-800) ?? unpack.status}`);
  const appRoot = join(destination, relativeRoot);
  cache.set(key, appRoot);
  return appRoot;
}

function renderReport(report) {
  const escape = (text) => String(text).replace(/[\r\n|`<>]/g, " ");
  const lines = [`## Cursor schema watch: ${escape(report.track)}`, "", `Outcome: **${escape(report.outcome)}**`, ""];
  if (report.error) lines.push(`Inspection error: ${escape(report.error)}`, "");
  else {
    lines.push(`Cursor: ${escape(report.version)}; baseline: ${escape(report.baselineVersion ?? "new inventory")}`, "",
      `Changed descriptors: ${report.changes.length}; unsupported parser fields: ${report.unsupportedFields.length}.`, "",
      "| Message | Field | Finding |", "| --- | --- | --- |");
    for (const change of report.changes) lines.push(`| ${escape(change.message)} | ${change.field ?? "message"} | ${escape(change.kind)}: ${escape(JSON.stringify(change.after ?? change.before ?? {}))} |`);
    for (const gap of report.unsupportedFields) lines.push(`| ${escape(gap.message)} | ${gap.field} (${escape(gap.name)}) | ${escape(gap.reason)} |`);
    if (report.baselineUpdated) lines.push("", "Inventory baseline written explicitly. Unsupported fields remain unsupported; this does not approve parser compatibility.");
    lines.push("", report.note);
  }
  return lines.join("\n") + "\n";
}
