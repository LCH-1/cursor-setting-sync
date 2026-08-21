import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  RecoveryStagingError,
  cleanupStagedRecovery,
  stageRecoveryArtifacts,
  type RecoveryStagingBridge,
  type RecoveryStagingFileKind,
  type RecoveryStagingSource,
  type RecoveryStagingUri,
} from "../src/chat/recoveryStaging";
import { sha256 } from "../src/protocol/canonical";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("remote recovery staging", () => {
  it("stages verified files but attaches only START-HERE and the transcript", async () => {
    const fixture = await sourcesFixture();
    const bridge = new MemoryStagingBridge();
    const workspace = remoteUri("/home/dev/project");
    const selected = remoteUri("/home/dev/private-recovery");
    bridge.addDirectory(selected);

    const result = await stageRecoveryArtifacts({
      workspaceUri: workspace,
      selectedRemoteBaseUri: selected,
      sources: fixture.sources,
      bridge,
      createId: () => "0123456789abcdef0123456789abcdef",
    });

    expect(result.directory.path).toBe(
      "/home/dev/private-recovery/cursor-setting-sync-recovery-0123456789abcdef0123456789abcdef",
    );
    expect(result.agentResources.map((resource) => fileName(resource))).toEqual([
      "START-HERE.md",
      `visible-${fixture.transcriptHash}.md`,
    ]);
    expect(
      result.agentResources.some((resource) => resource.path.endsWith(".png")),
    ).toBe(false);
    const image = result.stagedFiles.find((file) => file.kind === "image");
    expect(image).toBeDefined();
    const start = Buffer.from(
      await bridge.readFile(result.agentResources[0]),
    ).toString("utf8");
    expect(start).toContain("read_file_v2");
    expect(start).toContain(JSON.stringify(image?.uri.path));
    expect(start).toContain(JSON.stringify(image?.uri.toString()));
    expect(start).toContain(fixture.imageHash);
    expect(start).toContain(
      "could not verify or enforce this directory's remote permissions or ACLs",
    );
    expect(bridge.renames.every((rename) => rename.overwrite === false)).toBe(
      true,
    );
    expect(bridge.writes.some((path) => path.includes(".png."))).toBe(true);
    expect(bridge.writes.some((path) => path.endsWith("START-HERE.md"))).toBe(
      false,
    );
    expect(bridge.writes.some((path) => path.includes(".partial"))).toBe(true);
  });

  it("rejects a different authority before any remote filesystem operation", async () => {
    const fixture = await sourcesFixture();
    const bridge = new MemoryStagingBridge();

    await expect(
      stageRecoveryArtifacts({
        workspaceUri: remoteUri("/home/dev/project", "ssh-remote+server-a"),
        selectedRemoteBaseUri: remoteUri(
          "/home/dev/recovery",
          "ssh-remote+server-b",
        ),
        sources: fixture.sources,
        bridge,
      }),
    ).rejects.toThrow(/exact remote authority/u);

    expect(bridge.operations).toEqual([]);
  });

  it("rejects linked or pre-existing destination directories without writes", async () => {
    const fixture = await sourcesFixture();
    const selected = remoteUri("/home/dev/recovery");
    const linked = new MemoryStagingBridge();
    linked.addNode(selected, "symbolic-link");
    await expect(
      stageRecoveryArtifacts({
        workspaceUri: remoteUri("/home/dev/project"),
        selectedRemoteBaseUri: selected,
        sources: fixture.sources,
        bridge: linked,
      }),
    ).rejects.toThrow(/not a real directory/u);
    expect(linked.writes).toEqual([]);

    const collision = new MemoryStagingBridge();
    collision.addDirectory(selected);
    collision.addDirectory(
      remoteUri(
        "/home/dev/recovery/cursor-setting-sync-recovery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    );
    await expect(
      stageRecoveryArtifacts({
        workspaceUri: remoteUri("/home/dev/project"),
        selectedRemoteBaseUri: selected,
        sources: fixture.sources,
        bridge: collision,
        createId: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).rejects.toThrow(/already exists/u);
    expect(collision.writes).toEqual([]);
  });

  it("fails closed on a changed local source or corrupt remote read-back", async () => {
    const fixture = await sourcesFixture();
    const selected = remoteUri("/home/dev/recovery");
    const bridge = new MemoryStagingBridge();
    bridge.addDirectory(selected);
    await expect(
      stageRecoveryArtifacts({
        workspaceUri: remoteUri("/home/dev/project"),
        selectedRemoteBaseUri: selected,
        sources: [
          { ...fixture.sources[0]!, sha256: "0".repeat(64) },
          fixture.sources[1]!,
        ],
        bridge,
      }),
    ).rejects.toThrow(/changed or failed hash verification/u);
    expect(bridge.writes).toEqual([]);

    const corrupt = new MemoryStagingBridge();
    corrupt.addDirectory(selected);
    corrupt.corruptPartialReads = true;
    try {
      await stageRecoveryArtifacts({
        workspaceUri: remoteUri("/home/dev/project"),
        selectedRemoteBaseUri: selected,
        sources: fixture.sources,
        bridge: corrupt,
        createId: () => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      });
      throw new Error("Expected corrupt read-back staging to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryStagingError);
      if (!(error instanceof RecoveryStagingError)) {
        throw error;
      }
      expect(error.possiblyWrittenDirectory?.path).toContain(
        "cursor-setting-sync-recovery-bbbb",
      );
    }
    expect(corrupt.renames).toEqual([]);
  });

  it("cleans only an exact unchanged staging result and never recursively", async () => {
    const fixture = await sourcesFixture();
    const selected = remoteUri("/home/dev/recovery");
    const bridge = new MemoryStagingBridge();
    bridge.addDirectory(selected);
    const result = await stageRecoveryArtifacts({
      workspaceUri: remoteUri("/home/dev/project"),
      selectedRemoteBaseUri: selected,
      sources: fixture.sources,
      bridge,
      createId: () => "cccccccccccccccccccccccccccccccc",
    });

    await cleanupStagedRecovery(result, bridge);

    await expect(bridge.stat(result.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(bridge.deletes.length).toBe(result.stagedFiles.length + 1);
    expect(
      bridge.deletes.every(
        (deletion) =>
          deletion.options.recursive === false &&
          deletion.options.useTrash === false,
      ),
    ).toBe(true);
  });

  it("refuses cleanup when an extra or changed remote file exists", async () => {
    const fixture = await sourcesFixture();
    const selected = remoteUri("/home/dev/recovery");
    const bridge = new MemoryStagingBridge();
    bridge.addDirectory(selected);
    const result = await stageRecoveryArtifacts({
      workspaceUri: remoteUri("/home/dev/project"),
      selectedRemoteBaseUri: selected,
      sources: fixture.sources,
      bridge,
      createId: () => "dddddddddddddddddddddddddddddddd",
    });
    bridge.addFile(bridge.joinPath(result.directory, "unexpected.txt"), "x");

    await expect(cleanupStagedRecovery(result, bridge)).rejects.toThrow(
      /unexpected files/u,
    );
    expect(bridge.deletes).toEqual([]);

    bridge.remove(bridge.joinPath(result.directory, "unexpected.txt"));
    const transcript = result.stagedFiles.find(
      (file) => file.kind === "transcript",
    );
    expect(transcript).toBeDefined();
    bridge.addFile(transcript!.uri, "changed");
    await expect(cleanupStagedRecovery(result, bridge)).rejects.toThrow(
      /wrong size|hash verification/u,
    );
    expect(bridge.deletes).toEqual([]);
  });

  it("rejects invalid source counts and metadata before staging", async () => {
    const fixture = await sourcesFixture();
    const bridge = new MemoryStagingBridge();
    const selected = remoteUri("/home/dev/recovery");
    bridge.addDirectory(selected);

    await expect(
      stageRecoveryArtifacts({
        workspaceUri: remoteUri("/home/dev/project"),
        selectedRemoteBaseUri: selected,
        sources: fixture.sources.filter((source) => source.kind === "image"),
        bridge,
      }),
    ).rejects.toThrow(/exactly one transcript/u);
    await expect(
      stageRecoveryArtifacts({
        workspaceUri: remoteUri("/home/dev/project"),
        selectedRemoteBaseUri: selected,
        sources: [{ ...fixture.sources[0]!, byteLength: -1 }],
        bridge,
      }),
    ).rejects.toThrow(/invalid metadata/u);
    expect(bridge.writes).toEqual([]);
  });

  it("counts duplicate source reads against the fixed 34 MiB aggregate cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-recovery-staging-cap-"));
    temporaryRoots.push(root);
    const imageBytes = Buffer.alloc(16 * 1024 * 1024, 0x5a);
    const imagePath = join(root, "large.png");
    await writeFile(imagePath, imageBytes);
    const imageSource: RecoveryStagingSource = {
      kind: "image",
      localPath: imagePath,
      sha256: sha256(imageBytes),
      byteLength: imageBytes.byteLength,
      mimeType: "image/png",
    };
    const selected = remoteUri("/home/dev/recovery");
    const bridge = new MemoryStagingBridge();
    bridge.addDirectory(selected);

    await expect(
      stageRecoveryArtifacts({
        workspaceUri: remoteUri("/home/dev/project"),
        selectedRemoteBaseUri: selected,
        sources: [
          imageSource,
          imageSource,
          {
            kind: "transcript",
            localPath: join(root, "must-not-be-read.md"),
            sha256: "0".repeat(64),
            byteLength: 2 * 1024 * 1024 + 1,
            mimeType: "text/markdown",
          },
        ],
        bridge,
      }),
    ).rejects.toThrow(/aggregate remote staging safety bound/u);
    expect(bridge.writes).toEqual([]);
  });
});

async function sourcesFixture(): Promise<{
  sources: RecoveryStagingSource[];
  transcriptHash: string;
  imageHash: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "cursor-recovery-staging-test-"));
  temporaryRoots.push(root);
  const transcript = Buffer.from("# recovered\noriginal composer here\n", "utf8");
  const image = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
  ]);
  const transcriptPath = join(root, "recovery.md");
  const imagePath = join(root, "recovery.png");
  await writeFile(transcriptPath, transcript);
  await writeFile(imagePath, image);
  const transcriptHash = sha256(transcript);
  const imageHash = sha256(image);
  return {
    transcriptHash,
    imageHash,
    sources: [
      {
        kind: "transcript",
        localPath: transcriptPath,
        sha256: transcriptHash,
        byteLength: transcript.byteLength,
        mimeType: "text/markdown",
      },
      {
        kind: "image",
        localPath: imagePath,
        sha256: imageHash,
        byteLength: image.byteLength,
        mimeType: "image/png",
      },
    ],
  };
}

class MemoryStagingBridge implements RecoveryStagingBridge {
  readonly operations: string[] = [];
  readonly writes: string[] = [];
  readonly renames: Array<{ source: string; target: string; overwrite: false }> = [];
  readonly deletes: Array<{
    path: string;
    options: { recursive: false; useTrash: false };
  }> = [];
  corruptPartialReads = false;
  private readonly nodes = new Map<
    string,
    { kind: RecoveryStagingFileKind; bytes?: Buffer }
  >();

  addDirectory(uri: RecoveryStagingUri): void {
    this.addNode(uri, "directory");
  }

  addNode(uri: RecoveryStagingUri, kind: RecoveryStagingFileKind): void {
    this.nodes.set(uri.toString(), { kind });
  }

  addFile(uri: RecoveryStagingUri, value: string | Buffer): void {
    this.nodes.set(uri.toString(), {
      kind: "file",
      bytes: Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"),
    });
  }

  remove(uri: RecoveryStagingUri): void {
    this.nodes.delete(uri.toString());
  }

  joinPath(base: RecoveryStagingUri, ...segments: string[]): RecoveryStagingUri {
    return remoteUri(posix.join(base.path, ...segments), base.authority, base.scheme);
  }

  async stat(uri: RecoveryStagingUri): Promise<{
    kind: RecoveryStagingFileKind;
    size: number;
  }> {
    this.operations.push(`stat:${uri.path}`);
    const node = this.required(uri);
    return { kind: node.kind, size: node.bytes?.byteLength ?? 0 };
  }

  async createDirectory(uri: RecoveryStagingUri): Promise<void> {
    this.operations.push(`mkdir:${uri.path}`);
    if (!this.nodes.has(uri.toString())) {
      this.addDirectory(uri);
    }
  }

  async readFile(uri: RecoveryStagingUri): Promise<Uint8Array> {
    this.operations.push(`read:${uri.path}`);
    const node = this.required(uri);
    if (node.kind !== "file" || node.bytes === undefined) {
      throw Object.assign(new Error("not a file"), { code: "EISDIR" });
    }
    if (this.corruptPartialReads && uri.path.includes(".partial")) {
      return Buffer.concat([node.bytes, Buffer.from("corrupt", "utf8")]);
    }
    return Buffer.from(node.bytes);
  }

  async writeFile(uri: RecoveryStagingUri, bytes: Uint8Array): Promise<void> {
    this.operations.push(`write:${uri.path}`);
    this.writes.push(uri.path);
    this.nodes.set(uri.toString(), {
      kind: "file",
      bytes: Buffer.from(bytes),
    });
  }

  async rename(
    source: RecoveryStagingUri,
    target: RecoveryStagingUri,
    options: { overwrite: false },
  ): Promise<void> {
    this.operations.push(`rename:${source.path}->${target.path}`);
    this.renames.push({
      source: source.path,
      target: target.path,
      overwrite: options.overwrite,
    });
    if (this.nodes.has(target.toString())) {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    }
    const node = this.required(source);
    this.nodes.set(target.toString(), node);
    this.nodes.delete(source.toString());
  }

  async delete(
    uri: RecoveryStagingUri,
    options: { recursive: false; useTrash: false },
  ): Promise<void> {
    this.operations.push(`delete:${uri.path}`);
    this.deletes.push({ path: uri.path, options });
    const node = this.required(uri);
    if (node.kind === "directory" && (await this.readDirectory(uri)).length !== 0) {
      throw Object.assign(new Error("not empty"), { code: "ENOTEMPTY" });
    }
    this.nodes.delete(uri.toString());
  }

  async readDirectory(
    uri: RecoveryStagingUri,
  ): Promise<readonly { name: string; kind: RecoveryStagingFileKind }[]> {
    this.operations.push(`readdir:${uri.path}`);
    const node = this.required(uri);
    if (node.kind !== "directory") {
      throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    }
    const prefix = uri.path.endsWith("/") ? uri.path : `${uri.path}/`;
    const entries: Array<{ name: string; kind: RecoveryStagingFileKind }> = [];
    for (const [key, child] of this.nodes) {
      const parsed = new URL(key);
      if (!parsed.pathname.startsWith(prefix)) {
        continue;
      }
      const suffix = parsed.pathname.slice(prefix.length);
      if (suffix.length === 0 || suffix.includes("/")) {
        continue;
      }
      entries.push({ name: decodeURIComponent(suffix), kind: child.kind });
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }

  private required(uri: RecoveryStagingUri): {
    kind: RecoveryStagingFileKind;
    bytes?: Buffer;
  } {
    const node = this.nodes.get(uri.toString());
    if (node === undefined) {
      throw Object.assign(new Error(`missing: ${uri.toString()}`), {
        code: "ENOENT",
      });
    }
    return node;
  }
}

function remoteUri(
  path: string,
  authority = "ssh-remote+server-a",
  scheme = "vscode-remote",
): RecoveryStagingUri {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return {
    scheme,
    authority,
    path: normalized,
    query: "",
    fragment: "",
    fsPath: normalized,
    toString: () =>
      `${scheme}://${authority}${normalized
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")}`,
  };
}

function fileName(uri: RecoveryStagingUri): string {
  return uri.path.split("/").at(-1) ?? "";
}
