import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  compareCursorSchemas, CURSOR_MESSAGE_NAMES, extractCursorSchema,
  findCursorSchemaGaps, findSquashfsOffset, MONITORED_CURSOR_MESSAGES, validateCursorSnapshot,
  type CursorField, type CursorSchemaSnapshot,
} from "../src/monitor/cursorSchema";

const inventory: unknown = JSON.parse(readFileSync("scripts/cursor-schema-baseline.json", "utf8"));
validateCursorSnapshot(inventory);
const baseline = inventory;
const conversation = CURSOR_MESSAGE_NAMES["conversation-state"];
const agent = CURSOR_MESSAGE_NAMES["agent-turn"];

function bundleFor(snapshot: CursorSchemaSnapshot, prefix = "m"): string {
  const symbols = new Map<string, string>();
  const enums = new Set<string>();
  function collect(value: object): void {
    for (const [key, rawEntry] of Object.entries(value)) {
      const entry: unknown = rawEntry;
      if (key === "T" && typeof entry === "string") {
        if (!symbols.has(entry)) symbols.set(entry, `${prefix}${symbols.size}`);
        if ("kind" in value && value.kind === "enum") enums.add(entry);
      } else if (typeof entry === "object" && entry !== null) collect(entry);
    }
  }
  for (const name of Object.keys(snapshot.messages)) symbols.set(name, `${prefix}${symbols.size}`);
  for (const fields of Object.values(snapshot.messages)) for (const field of fields) collect(field);
  function literal(value: unknown, key = ""): string {
    if (key === "T" && typeof value === "string") return symbols.get(value)!;
    if (Array.isArray(value)) return `[${value.map((entry: unknown) => literal(entry)).join(",")}]`;
    if (typeof value === "object" && value !== null) return `{${Object.entries(value).map(([name, entry]) => `${name}:${literal(entry, name)}`).join(",")}}`;
    if (typeof value === "boolean") return value ? "!0" : "!1";
    return JSON.stringify(value);
  }
  return [...symbols.entries()].map(([name, symbol]) =>
    enums.has(name) ? `${symbol}=p.makeEnum(${JSON.stringify(name)},[])`
      : `${symbol}=p.makeMessageType(${JSON.stringify(name)},()=>${literal(snapshot.messages[name] ?? [])})`,
  ).join(",");
}

function changedField(name: string, number: number, changes: Partial<CursorField>): CursorSchemaSnapshot {
  const snapshot = structuredClone(baseline);
  const field = snapshot.messages[name]!.find((entry) => entry.no === number)!;
  Object.assign(field, changes);
  return snapshot;
}

describe("Cursor schema preflight", () => {
  it("extracts aliases, generated class descriptors and complete referenced enums without executing vendor code", () => {
    const empty = MONITORED_CURSOR_MESSAGES.filter(name => name !== conversation).map((name, i) => `r${i}=p.makeMessageType(${JSON.stringify(name)},()=>[])`).join(";");
    const source = `${empty};root=p.makeMessageType(${JSON.stringify(conversation)},()=>[{no:5,name:"token_details",kind:"message",T:alias},{no:10,name:"mode",kind:"enum",T:en}]);alias=other;other.typeName="fixture.Opaque";other.fields=p.newFieldList(()=>[{no:1,name:"value",kind:"scalar",T:9}]);en=p.makeEnum("fixture.Mode",[{no:0,name:"DEFAULT"},{no:1,name:"ACTIVE"}]);throw new Error("never execute");`;
    const result = extractCursorSchema(source, true);
    expect(result.messages[conversation]![0]!.T).toBe("fixture.Opaque");
    expect(result.messages["fixture.Opaque"]).toEqual([{ no: 1, name: "value", kind: "scalar", T: 9 }]);
    expect(result.enums!["fixture.Mode"]).toEqual([{ no: 0, name: "DEFAULT" }, { no: 1, name: "ACTIVE" }]);
  });
  it("extracts the complete public inventory without evaluating Cursor code", () => {
    const source = `throw new Error('never execute bundled code');${bundleFor(baseline)}`;
    const observed = extractCursorSchema(source);
    expect(Object.keys(observed.messages)).toHaveLength(MONITORED_CURSOR_MESSAGES.length);
    expect(compareCursorSchemas(baseline, observed)).toEqual([]);
  });

  it("ignores minifier symbol changes and descriptor property order", () => {
    const one = extractCursorSchema(bundleFor(baseline, "$x"));
    const two = extractCursorSchema(bundleFor(baseline, "other"));
    expect(compareCursorSchemas(one, two)).toEqual([]);
    const reordered = structuredClone(one);
    const field = reordered.messages[conversation]![0]!;
    reordered.messages[conversation]![0] = Object.fromEntries(Object.entries(field).reverse()) as CursorField;
    expect(compareCursorSchemas(one, reordered)).toEqual([]);
  });

  it("detects all four additions that caused the Cursor 3.23 incident", () => {
    const previous = structuredClone(baseline);
    previous.messages[conversation] = previous.messages[conversation]!.filter((f) => ![38, 39].includes(f.no));
    previous.messages[agent] = previous.messages[agent]!.filter((f) => ![9, 10].includes(f.no));
    expect(compareCursorSchemas(previous, extractCursorSchema(bundleFor(baseline))).map((c) => [c.message, c.field, c.kind]))
      .toEqual([[agent, 9, "added"], [agent, 10, "added"], [conversation, 38, "added"], [conversation, 39, "added"]]);
  });

  it.each([
    ["type", { T: 13 }], ["name", { name: "renamed_recent_ids" }],
    ["cardinality", { repeated: false }], ["oneof", { oneof: "new_selection" }],
  ])("detects a field %s change", (_label, change) => {
    const after = extractCursorSchema(bundleFor(changedField(conversation, 38, change)));
    expect(compareCursorSchemas(baseline, after)).toEqual([expect.objectContaining({ message: conversation, field: 38, kind: "changed" })]);
  });

  it("detects removal and never silently approves a missing descriptor", () => {
    const changed = structuredClone(baseline);
    changed.messages[conversation] = changed.messages[conversation]!.filter((f) => f.no !== 38);
    expect(compareCursorSchemas(baseline, changed)).toEqual([expect.objectContaining({ field: 38, kind: "removed" })]);
    delete changed.messages[conversation];
    const missing = bundleFor(changed).replace(`makeMessageType(${JSON.stringify(conversation)},`, 'makeMessageType("agent.v1.RenamedState",');
    expect(() => extractCursorSchema(missing)).toThrow("Missing protobuf descriptor");
  });

  it("flags an unknown blob-capable field even after an inventory baseline update", () => {
    const changed = structuredClone(baseline);
    changed.messages[conversation]!.push({ no: 99, name: "future_blob", kind: "scalar", T: 12 });
    const observed = extractCursorSchema(bundleFor(changed));
    expect(compareCursorSchemas(observed, observed)).toEqual([]);
    expect(findCursorSchemaGaps(observed)).toContainEqual(expect.objectContaining({ field: 99, reason: "Field is not supported by the continuation parser" }));
  });

  it("rejects changed wire types and string replacements of blob references", () => {
    expect(findCursorSchemaGaps(changedField(conversation, 38, { T: 13 })))
      .toContainEqual(expect.objectContaining({ field: 38, reason: "Wire type is not supported by the continuation parser" }));
    expect(findCursorSchemaGaps(changedField(conversation, 8, { T: 9 })))
      .toContainEqual(expect.objectContaining({ field: 8, reason: "Reference or embedded message no longer matches the continuation parser" }));
  });

  it("detects a different embedded message and nested image additions", () => {
    const context = CURSOR_MESSAGE_NAMES["selected-context"];
    expect(findCursorSchemaGaps(changedField(context, 2, { T: "agent.v1.DifferentContext" })))
      .toContainEqual(expect.objectContaining({ field: 2, reason: "Reference or embedded message no longer matches the continuation parser" }));
    const changed = structuredClone(baseline);
    const image = "agent.v1.SelectedImage.BlobIdWithData";
    changed.messages[image]!.push({ no: 3, name: "more_data", kind: "scalar", T: 12 });
    expect(findCursorSchemaGaps(changed)).toContainEqual(expect.objectContaining({ message: image, field: 3 }));
  });

  it("does not confuse generated string metadata with blob references", () => {
    const supported = [38, 39];
    expect(findCursorSchemaGaps(baseline).filter((g) => g.message === conversation && supported.includes(g.field))).toEqual([]);
    expect(findCursorSchemaGaps(baseline).filter((g) => g.message === agent && [9, 10].includes(g.field))).toEqual([]);
  });

  it.each([
    ["executable descriptor", "()=>{throw new Error('not a literal')}"],
    ["spread fields", "()=>[...other]"],
    ["computed property", "()=>[{[getName()]:1}]"],
    ["computed scalar", '()=>[{no:1,name:"content",kind:"scalar",T:danger()}]'],
    ["new descriptor property", '()=>[{no:1,name:"content",kind:"scalar",T:12,unknownFlag:!0}]'],
  ])("fails inspection on %s instead of reporting compatibility", (_label, expression) => {
    const source = bundleFor(baseline);
    const start = source.indexOf(`p.makeMessageType(${JSON.stringify(conversation)},`);
    const malformed = source.slice(0, start) + `p.makeMessageType(${JSON.stringify(conversation)},${expression})`;
    expect(() => extractCursorSchema(malformed)).toThrow();
  });

  it("rejects duplicate fields and malformed baselines", () => {
    const changed = structuredClone(baseline);
    changed.messages[conversation]!.push(changed.messages[conversation]![0]!);
    expect(() => extractCursorSchema(bundleFor(changed))).toThrow("Duplicate field");
    expect(() => validateCursorSnapshot(changed)).toThrow("Invalid baseline field");
    expect(() => validateCursorSnapshot({ formatVersion: 2, messages: baseline.messages })).toThrow("Invalid Cursor schema baseline");
    expect(() => validateCursorSnapshot({ formatVersion: 1, messages: {} })).toThrow("Missing baseline descriptor");
  });
});

describe("Cursor schema watch command", () => {
  function run(snapshot: CursorSchemaSnapshot, broken = false) {
    const parent = resolve("tmp");
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, "cursor-watch-test-"));
    const app = join(directory, "app");
    mkdirSync(join(app, "out/vs/workbench"), { recursive: true });
    writeFileSync(join(app, "product.json"), JSON.stringify({ version: "9.1.0", vscodeVersion: "1.99.0" }));
    writeFileSync(join(app, "out/vs/workbench/workbench.desktop.main.js"), broken ? "changed bundle layout" : bundleFor(snapshot));
    const baselinePath = join(directory, "baseline.json");
    writeFileSync(baselinePath, JSON.stringify(snapshot));
    const outdir = join(directory, "reports");
    const result = spawnSync(process.execPath, ["scripts/cursor-schema-watch.mjs", "--app-root", app, "--baseline", baselinePath, "--outdir", outdir],
      { encoding: "utf8", timeout: 30_000, env: { ...process.env, GITHUB_STEP_SUMMARY: join(directory, "summary.md") } });
    expect(result.error).toBeUndefined();
    const report: unknown = JSON.parse(readFileSync(join(outdir, "installed/report.json"), "utf8"));
    return { result, report, summary: readFileSync(join(directory, "summary.md"), "utf8"), baselinePath };
  }

  it("writes a failing report for parser gaps while leaving the baseline untouched", () => {
    const { result, report, summary, baselinePath } = run(baseline);
    expect(result.status).toBe(1);
    expect(report).toMatchObject({ outcome: "unsupported", changes: [] });
    expect(summary).toContain("unsupported parser fields:");
    expect(readFileSync(baselinePath, "utf8")).toBe(JSON.stringify(baseline));
  }, 35_000);

  it("reports extraction failure instead of a passing empty comparison", () => {
    const { result, report, summary } = run(baseline, true);
    expect(result.status).toBe(1);
    expect(report).toMatchObject({ outcome: "inspection-failed" });
    expect(summary).toContain("Missing protobuf descriptor");
  }, 35_000);

  it("passes a matching inventory when every observed field is supported", () => {
    const supported = structuredClone(baseline);
    for (const gap of findCursorSchemaGaps(supported)) {
      supported.messages[gap.message] = supported.messages[gap.message]!.filter((field) => field.no !== gap.field);
    }
    const { result, report } = run(supported);
    expect(result.status).toBe(0);
    expect(report).toMatchObject({ outcome: "unchanged", unsupportedFields: [], changes: [] });
  }, 35_000);
});

describe("AppImage archive location", () => {
  it("finds a valid SquashFS header across stream chunk boundaries", async () => {
    mkdirSync("tmp", { recursive: true });
    const directory = mkdtempSync(resolve("tmp/cursor-watch-header-"));
    const file = join(directory, "archive");
    const bytes = Buffer.alloc(1024 * 1024 + 100);
    bytes.write("hsqs", 8);
    bytes.writeUInt16LE(3, 8 + 28);
    const offset = 1024 * 1024 - 2;
    bytes.write("hsqs", offset);
    bytes.writeUInt16LE(4, offset + 28);
    writeFileSync(file, bytes);
    expect(await findSquashfsOffset(file)).toBe(offset);
  });

  it("rejects unrecognized archives instead of invoking an executable", async () => {
    mkdirSync("tmp", { recursive: true });
    const directory = mkdtempSync(resolve("tmp/cursor-watch-header-"));
    const file = join(directory, "archive");
    writeFileSync(file, "not a recognized filesystem");
    await expect(findSquashfsOffset(file)).rejects.toThrow("no recognized SquashFS");
  });
});
