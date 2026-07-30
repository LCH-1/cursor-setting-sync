import { describe, expect, it } from "vitest";

import {
  isRemoteTargetsKey,
  mergeRemoteTargetsBuffers,
  remoteTargetsKeys,
} from "../src/resources/remoteTargets";

const FIELD = "remoteLocationHistory_v0";

describe("the SSH targets merge", () => {
  it("keeps every host and folder either computer knows", () => {
    // The whole point: two machines that reach the same servers should not
    // have to rediscover each other's folders. Nothing here is a disagreement.
    const a = targets({
      nas: ["/home/ubuntu/servers", "/home/ubuntu/servers/cgv"],
      myart: ["/home/ubuntu/server"],
    });
    const b = targets({
      nas: ["/home/ubuntu/servers/newone"],
      sentry_azure: ["/home/ubuntu/server/sentry"],
    });

    const merged = parsed(mergeRemoteTargetsBuffers(a, b));

    expect(Object.keys(merged).sort()).toEqual(["myart", "nas", "sentry_azure"]);
    expect(merged["nas"]).toEqual([
      "/home/ubuntu/servers",
      "/home/ubuntu/servers/cgv",
      "/home/ubuntu/servers/newone",
    ]);
    expect(merged["sentry_azure"]).toEqual(["/home/ubuntu/server/sentry"]);
  });

  it("leads with the preferred side's order, because the list is most-recent-first", () => {
    const a = targets({ nas: ["/second", "/first"] });
    const b = targets({ nas: ["/first", "/third"] });

    expect(parsed(mergeRemoteTargetsBuffers(a, b))["nas"]).toEqual([
      "/second",
      "/first",
      "/third",
    ]);
    expect(parsed(mergeRemoteTargetsBuffers(b, a))["nas"]).toEqual([
      "/first",
      "/third",
      "/second",
    ]);
  });

  it("does not duplicate a folder both computers have opened", () => {
    const same = targets({ nas: ["/home/ubuntu/servers"] });
    expect(parsed(mergeRemoteTargetsBuffers(same, same))["nas"]).toEqual([
      "/home/ubuntu/servers",
    ]);
  });

  it("declines a shape it does not know rather than guessing", () => {
    const valid = targets({ nas: ["/x"] });
    for (const broken of [
      Buffer.from("not json", "utf8"),
      // A future Cursor renaming the wrapper field.
      Buffer.from(JSON.stringify({ someOtherField: { nas: ["/x"] } }), "utf8"),
      // Folders that are not strings.
      Buffer.from(JSON.stringify({ [FIELD]: { nas: [{ path: "/x" }] } }), "utf8"),
      Buffer.from(JSON.stringify({ [FIELD]: { nas: "/x" } }), "utf8"),
      Buffer.from(JSON.stringify([1, 2]), "utf8"),
    ]) {
      expect(mergeRemoteTargetsBuffers(valid, broken).status).toBe("conflict");
      expect(mergeRemoteTargetsBuffers(broken, valid).status).toBe("conflict");
    }
  });

  it("carries exactly the two known keys and nothing else", () => {
    expect(remoteTargetsKeys().sort()).toEqual([
      "anysphere.remote-ssh",
      "ms-vscode-remote.remote-ssh",
    ]);
    for (const key of remoteTargetsKeys()) {
      expect(isRemoteTargetsKey(key)).toBe(true);
    }
    // A peer naming anything else under this kind is claiming a write the
    // allowlist never granted.
    for (const key of [
      "anysphere.remote-wsl",
      "history.recentlyOpenedPathsList",
      "secret://github",
      "",
    ]) {
      expect(isRemoteTargetsKey(key)).toBe(false);
    }
  });
});

function targets(hosts: Record<string, string[]>): Buffer {
  return Buffer.from(JSON.stringify({ [FIELD]: hosts }), "utf8");
}

function parsed(outcome: {
  status: string;
  content?: Buffer;
}): Record<string, string[]> {
  expect(outcome.status).toBe("merged");
  const value = JSON.parse(
    (outcome.content ?? Buffer.alloc(0)).toString("utf8"),
  ) as Record<string, Record<string, string[]>>;
  return value[FIELD] ?? {};
}
