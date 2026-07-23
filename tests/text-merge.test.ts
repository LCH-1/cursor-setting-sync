import { describe, expect, it } from "vitest";
import { mergeTextBuffers } from "../src/resources/text";

describe("text merge line endings", () => {
  it("produces byte-identical output when local and remote are swapped", () => {
    const base = Buffer.from("alpha\r\nbravo\r\ncharlie\r\ndelta\r\n", "utf8");
    const local = Buffer.from("alpha-one\nbravo\ncharlie\ndelta\n", "utf8");
    const remote = Buffer.from("alpha\r\nbravo\r\ncharlie\r\ndelta-two\r\n", "utf8");

    const forward = mergeTextBuffers(base, local, remote);
    const swapped = mergeTextBuffers(base, remote, local);

    expect(forward.status).toBe("merged");
    expect(swapped.status).toBe("merged");
    if (forward.content === undefined || swapped.content === undefined) {
      throw new Error("Expected merged content on both sides.");
    }
    expect(forward.content.equals(swapped.content)).toBe(true);
    expect(forward.content.toString("utf8")).toBe(
      "alpha-one\r\nbravo\r\ncharlie\r\ndelta-two\r\n",
    );
  });

  it("joins with the base's dominant EOL instead of the local side's", () => {
    const base = Buffer.from("one\ntwo\nthree\n", "utf8");
    const local = Buffer.from("one-local\r\ntwo\r\nthree\r\n", "utf8");
    const remote = Buffer.from("one\ntwo\nthree-remote\n", "utf8");

    const outcome = mergeTextBuffers(base, local, remote);

    expect(outcome.status).toBe("merged");
    expect(outcome.content?.toString("utf8")).toBe(
      "one-local\ntwo\nthree-remote\n",
    );
  });

  it("falls back to LF when the base has no line breaks", () => {
    const base = Buffer.from("alpha", "utf8");
    const local = Buffer.from("beta", "utf8");
    const remote = Buffer.from("gamma", "utf8");

    const outcome = mergeTextBuffers(base, local, remote);

    expect(outcome.status).toBe("conflict");
    const conflictText = outcome.conflictContent?.toString("utf8") ?? "";
    expect(conflictText).toContain("\n");
    expect(conflictText).not.toContain("\r");
  });
});
