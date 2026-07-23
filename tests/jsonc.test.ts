import { describe, expect, it } from "vitest";
import {
  mergeJsoncBuffers,
  mergeJsonValues,
  parseJsoncObject,
  setJsoncProperty,
} from "../src/resources/jsonc";

describe("JSONC resource merge", () => {
  it("merges independent object keys", () => {
    const result = mergeJsonValues(
      { editor: { fontSize: 14, tabSize: 2 } },
      { editor: { fontSize: 16, tabSize: 2 } },
      { editor: { fontSize: 14, tabSize: 4 } },
    );

    expect(result.conflicts).toEqual([]);
    expect(result.value).toEqual({
      editor: { fontSize: 16, tabSize: 4 },
    });
  });

  it("reports a conflict for one concurrently edited value", () => {
    const result = mergeJsonValues(14, 16, 18);

    expect(result.conflicts).toEqual(["$"]);
    expect(result.value).toBe(16);
  });

  it("preserves comments while editing a setting", () => {
    const source = `{
  // Keep this explanation.
  "editor.fontSize": 14
}
`;
    const updated = setJsoncProperty(source, ["editor.fontSize"], 16);

    expect(updated).toContain("// Keep this explanation.");
    expect(parseJsoncObject(updated, "settings.json")["editor.fontSize"]).toBe(16);
  });

  it("distinguishes deletion from a null value", () => {
    const source = `{"example": null, "keep": true}`;
    const updated = setJsoncProperty(source, ["example"], undefined);

    expect(parseJsoncObject(updated, "settings.json")).toEqual({ keep: true });
  });

  it("preserves local comments on untouched lines during a buffer merge", () => {
    const base = Buffer.from(
      `{
  // Explains the port choice.
  "port": 3000,
  "obsolete": true,
  "theme": "light"
}
`,
      "utf8",
    );
    const local = Buffer.from(
      `{
  // Explains the port choice.
  "port": 3000,
  "obsolete": true,
  "theme": "dark"
}
`,
      "utf8",
    );
    const remote = Buffer.from(
      `{
  // Explains the port choice.
  "port": 8080,
  "theme": "light"
}
`,
      "utf8",
    );

    const outcome = mergeJsoncBuffers(base, local, remote);

    expect(outcome.status).toBe("merged");
    const content = outcome.content?.toString("utf8") ?? "";
    expect(content).toContain("// Explains the port choice.");
    expect(parseJsoncObject(content, "merged")).toEqual({
      port: 8080,
      theme: "dark",
    });
  });

  it("preserves an own __proto__ key during a three-way merge", () => {
    const base = JSON.parse("{}") as Record<string, never>;
    const local = JSON.parse(
      '{"__proto__":{"enabled":true}}',
    ) as Record<string, never>;
    const remote = JSON.parse('{"remote":1}') as Record<string, never>;

    const result = mergeJsonValues(base, local, remote);

    expect(result.conflicts).toEqual([]);
    expect(Object.getPrototypeOf(result.value)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result.value, "__proto__")).toBe(
      true,
    );
    expect(JSON.stringify(result.value)).toBe(
      '{"__proto__":{"enabled":true},"remote":1}',
    );
  });
});
