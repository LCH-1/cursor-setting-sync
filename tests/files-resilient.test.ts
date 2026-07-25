import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isTransientIoError,
  readFileResilient,
  retryTransientRead,
  statResilient,
} from "../src/platform/files";

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("transient read resilience", () => {
  it("classifies cloud-provider I/O errors as transient but not missing files", () => {
    for (const code of ["UNKNOWN", "EBUSY", "EIO", "EPERM", "ETIMEDOUT"]) {
      expect(isTransientIoError(errnoError(code))).toBe(true);
    }
    expect(isTransientIoError(errnoError("ENOENT"))).toBe(false);
    expect(isTransientIoError(new Error("plain"))).toBe(false);
  });

  it("retries a transient read and returns the eventual success", async () => {
    let calls = 0;
    const result = await retryTransientRead(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw errnoError("UNKNOWN");
        }
        return "ok";
      },
      4,
      1,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after the attempt budget on a persistent transient error", async () => {
    let calls = 0;
    await expect(
      retryTransientRead(
        async () => {
          calls += 1;
          throw errnoError("EBUSY");
        },
        3,
        1,
      ),
    ).rejects.toThrow(/EBUSY/);
    expect(calls).toBe(3);
  });

  it("does not retry a non-transient error", async () => {
    let calls = 0;
    await expect(
      retryTransientRead(
        async () => {
          calls += 1;
          throw errnoError("ENOENT");
        },
        4,
        1,
      ),
    ).rejects.toThrow(/ENOENT/);
    expect(calls).toBe(1);
  });

  it("reads a real file through the resilient helpers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resilient-read-"));
    try {
      const path = join(dir, "event.cse");
      await writeFile(path, "payload", "utf8");
      expect((await statResilient(path)).size).toBe(7);
      expect((await readFileResilient(path)).toString("utf8")).toBe("payload");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
