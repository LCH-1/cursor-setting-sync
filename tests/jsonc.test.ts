import { describe, expect, it } from "vitest";
import {
  mergeJsoncBuffers,
  mergeJsonValues,
  parseJsoncObject,
  setJsoncProperty,
} from "../src/resources/jsonc";

describe("JSONC resource merge", () => {
  it("rejects excessive nesting before jsonc-parser materializes it", () => {
    const source = `${"[".repeat(129)}0${"]".repeat(129)}`;

    expect(() => parseJsoncObject(source, "deep.jsonc")).toThrow(
      "128-level automatic parse depth limit",
    );
  });

  it("rejects excessive structural tokens before object materialization", () => {
    const source = `{${Array.from(
      { length: 32_769 },
      (_, index) => `"k${index}":0`,
    ).join(",")}}`;

    expect(() => parseJsoncObject(source, "wide.jsonc")).toThrow(
      "65536-token automatic parse limit",
    );
  });

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

describe("JSONC merge comment preservation", () => {
  const buffer = (text: string): Buffer => Buffer.from(text, "utf8");

  it("keeps a comment added on one side only, identically on both devices", () => {
    // tasks.json: A annotates the command it edited, B edits a different task.
    const base = buffer(
      `{
  "build": "tsc",
  "deploy": "scp"
}
`,
    );
    const withComment = buffer(
      `{
  "build": "tsc",
  // only works with the corp VPN
  "deploy": "scp -P 2222"
}
`,
    );
    const other = buffer(
      `{
  "build": "tsc --build",
  "deploy": "scp"
}
`,
    );

    const onA = mergeJsoncBuffers(base, withComment, other);
    const onB = mergeJsoncBuffers(base, other, withComment);

    expect(onA.status).toBe("merged");
    expect(onA.content?.toString("utf8")).toContain(
      "// only works with the corp VPN",
    );
    expect(onB.content?.toString("utf8")).toContain(
      "// only works with the corp VPN",
    );
    expect(onA.content?.toString("utf8")).toBe(onB.content?.toString("utf8"));
    expect(onA.semanticHash).toBe(onB.semanticHash);
    expect(parseJsoncObject(onA.content?.toString("utf8") ?? "", "merged")).toEqual({
      build: "tsc --build",
      deploy: "scp -P 2222",
    });
  });

  it("reports a conflict instead of dropping a comment when both sides annotate", () => {
    const base = buffer(
      `{
  "build": "tsc",
  "deploy": "scp"
}
`,
    );
    const left = buffer(
      `{
  // needs the corp VPN
  "build": "tsc",
  "deploy": "scp -P 2222"
}
`,
    );
    const right = buffer(
      `{
  "build": "tsc --build",
  // staging only
  "deploy": "scp"
}
`,
    );

    const onA = mergeJsoncBuffers(base, left, right);
    const onB = mergeJsoncBuffers(base, right, left);

    expect(onA.status).toBe("conflict");
    expect(onB.status).toBe("conflict");
    expect(onA.content).toBeUndefined();
    expect(onB.content).toBeUndefined();
  });

  it("auto-merges when both sides added the identical comment", () => {
    const base = buffer(`{\n  "a": 1,\n  "b": 1\n}\n`);
    const left = buffer(`{\n  // shared note\n  "a": 1,\n  "b": 1\n}\n`);
    const right = buffer(`{\n  // shared note\n  "a": 1,\n  "b": 1\n}\n`);

    const outcome = mergeJsoncBuffers(base, left, right);

    expect(outcome.status).toBe("unchanged");
    expect(outcome.content?.toString("utf8")).toContain("// shared note");
  });

  it("leaves a comment-only local edit untouched when the remote did not move", () => {
    const base = buffer(`{\n  "a": 1\n}\n`);
    const local = buffer(`{\n  // annotated locally\n  "a": 1\n}\n`);

    const outcome = mergeJsoncBuffers(base, local, base);

    expect(outcome.status).toBe("unchanged");
    expect(outcome.content?.toString("utf8")).toBe(local.toString("utf8"));
  });
});
