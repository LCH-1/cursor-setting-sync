import { describe, expect, it } from "vitest";
import fixture from "./fixtures/chat-snapshot.json";
import { parsePortableChatSnapshot } from "../src/chat/stateVscdb";

describe("portable chat snapshot", () => {
  it("accepts an anonymous valid fixture", () => {
    const parsed = parsePortableChatSnapshot(
      Buffer.from(JSON.stringify(fixture), "utf8"),
    );

    expect(parsed.bubbles).toHaveLength(1);
    expect(parsed.header.workspaceId).toBe("anonymous-workspace");
  });

  it("rejects a bubble belonging to another conversation", () => {
    const invalid = structuredClone(fixture);
    invalid.bubbles[0]!.key =
      "bubbleId:11111111-1111-4111-8111-111111111111:message";

    expect(() =>
      parsePortableChatSnapshot(Buffer.from(JSON.stringify(invalid), "utf8")),
    ).toThrow("another composer");
  });

  it("accepts and preserves per-row storage classes", () => {
    const typed = structuredClone(fixture);
    (typed.composerData as Record<string, unknown>).valueType = "text";
    (typed.bubbles[0] as Record<string, unknown>).valueType = "blob";

    const parsed = parsePortableChatSnapshot(
      Buffer.from(JSON.stringify(typed), "utf8"),
    );

    expect(parsed.composerData.valueType).toBe("text");
    expect(parsed.bubbles[0]?.valueType).toBe("blob");
  });

  it("rejects an unknown storage class", () => {
    const invalid = structuredClone(fixture);
    (invalid.bubbles[0] as Record<string, unknown>).valueType = "integer";

    expect(() =>
      parsePortableChatSnapshot(Buffer.from(JSON.stringify(invalid), "utf8")),
    ).toThrow("storage class");
  });
});
