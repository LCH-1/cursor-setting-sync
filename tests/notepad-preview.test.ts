import { describe, expect, it } from "vitest";

import {
  isNotepadsResourceId,
  renderNotepadsPreview,
} from "../src/ui/notepadPreview";

describe("the notepad conflict preview", () => {
  it("renders notes as text a person can read instead of one escaped line", () => {
    // What the diff showed before: a single enormous line per note, with every
    // paragraph break spelled \r\n in the middle of it. The reviewer could see
    // that something differed without being able to read either version.
    const payload = JSON.stringify([
      {
        id: "1768375296324drez9t4",
        name: "끊기는원인",
        text: "재부팅 전 실제로 무슨 일이\r\n\r\n# cpu\r\ndocker stats --no-stream",
      },
    ]);

    const rendered = renderNotepadsPreview(payload) ?? "";

    expect(rendered).toContain("끊기는원인");
    expect(rendered).toContain("[id 1768375296324drez9t4]");
    // The escapes are gone: these are real lines now.
    expect(rendered).not.toContain("\\r\\n");
    expect(rendered).toContain("# cpu\ndocker stats --no-stream");
  });

  it("normalizes line endings so one side's CRLF is not a whole-file diff", () => {
    const crlf = JSON.stringify([{ id: "1", name: "n", text: "a\r\nb" }]);
    const lf = JSON.stringify([{ id: "1", name: "n", text: "a\nb" }]);

    expect(renderNotepadsPreview(crlf)).toBe(renderNotepadsPreview(lf));
  });

  it("names an untitled note and one with no text rather than rendering nothing", () => {
    const rendered =
      renderNotepadsPreview(JSON.stringify([{ id: "1", name: "  " }])) ?? "";

    expect(rendered).toContain("(untitled)");
    expect(rendered).toContain("(this note has no text)");
  });

  it("declines a payload it cannot read, so the caller can show the raw bytes", () => {
    for (const payload of [
      "not json",
      JSON.stringify({ notepads: [] }),
      JSON.stringify([{ name: "no id" }]),
    ]) {
      expect(renderNotepadsPreview(payload)).toBeNull();
    }
    expect(renderNotepadsPreview("[]")).toBe("(no notepads)\n");
  });

  it("recognizes only a workspace's notepads.json", () => {
    const notepads = `workspace-storage/${encodeURIComponent(
      "703f151ce2095257aebae8e68adf30c0/notepads.json",
    )}`;
    expect(isNotepadsResourceId(notepads)).toBe(true);

    for (const other of [
      `workspace-storage/${encodeURIComponent("703f151c/state.vscdb")}`,
      `workspace-storage/${encodeURIComponent("703f151c/images/a.png")}`,
      "settings/settings.json",
    ]) {
      expect(isNotepadsResourceId(other)).toBe(false);
    }
  });
});
