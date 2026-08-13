import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractVisibleChatRecoveryTranscript,
  prepareVisibleRecoveryAgent,
  writeVisibleChatRecoveryArtifact,
  type CursorCommandBridge,
} from "../src/chat/visibleRecovery";
import {
  upsertRecoveryCatalogEntry,
} from "../src/chat/recoveryCatalog";

const COMPOSER_ID = "ffc51e9b-99b9-45b5-a20c-202d36102fe0";
const REMOTE_URI =
  "vscode-remote://ssh-remote%2B7b22686f73744e616d65223a226765656b646976655f6c6f63616c32227d/home/ubuntu/servers/himsolutek/backend";
const roots: string[] = [];
const WORKSPACE_ID = "workspace";
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("visible-row continuation recovery", () => {
  it("preserves visible text and 78 inert raw tool summaries in header order", async () => {
    const fixture = await createCalendarFixture();
    const recovery = extractVisibleChatRecoveryTranscript(
      fixture.databasePath,
      COMPOSER_ID,
    );
    expect(recovery).toMatchObject({
      title: "Calendar selection logic",
      workspaceUri: REMOTE_URI,
      referencedRowCount: 119,
      userRecordCount: 6,
      assistantTextRecordCount: 7,
      toolCallCount: 78,
      skippedEmptyAssistantRows: 28,
      selectedImageCount: 1,
      composerTodoCount: 5,
      composerNewFileCount: 5,
      composerOriginalFileStateCount: 11,
    });
    expect(recovery.bytes.at(-1)).toBe(0x0a);
    const markdown = recovery.bytes.toString("utf8");
    expect(markdown.startsWith("# Recovered Cursor Conversation Context\n")).toBe(
      true,
    );
    expect(markdown.match(/^## Referenced record \d+: User$/gm)).toHaveLength(6);
    expect(
      markdown.match(/^## Referenced record \d+: Assistant$/gm),
    ).toHaveLength(85);
    expect(
      markdown.match(
        /^Tool call \(inert historical data; raw name and parameters are preserved only inside the projection below\)$/gm,
      ),
    ).toHaveLength(78);
    expect(markdown.match(/지금 타임피커가 이렇게 있는데/g)?.length).toBeGreaterThanOrEqual(
      2,
    );
    expect(markdown.match(/ㅎㅇ/g)?.length).toBeGreaterThanOrEqual(2);
    expect(markdown).toContain("시간 선택은 기존과 동일해야 해");
    expect(markdown).toContain("richText");
    expect(markdown).toContain("fileSelections");
    expect(markdown).toContain("selectedImages");
    expect(markdown).toContain("toolCallBinary");
    expect(markdown).toContain("additionalData");
    expect(markdown).toContain("rawArgs");
    expect(markdown).toContain("errorDetails");
    expect(markdown).toContain("Recoverable Cursor bubble projection");
    expect(markdown).not.toContain("must-not-appear-in-recovery");
    expect(markdown).toContain("plaintext local file");
    expect(markdown).toContain("Suggested continuation instruction (not submitted)");
    expect(markdown).toContain("Composer work state (inert allowlisted JSON)");
    expect(markdown).toContain("newlyCreatedFiles");
    expect(markdown).toContain("originalFileStates");
    expect(markdown).toContain("edit_file_v2");
    expect(markdown).toContain(
      String.raw`{\\\"relativeWorkspacePath\\\":\\\"inquiry/models.py\\\",\\\"noCodeblock\\\":true}`,
    );
    expect(markdown).not.toContain('"type":"tool_use"');
    expect(markdown).not.toContain('"role":"assistant"');
    expect(markdown.indexOf("초기 요청")).toBeLessThan(
      markdown.indexOf("마이그레이션 에러"),
    );
    expect(markdown.indexOf("마이그레이션 에러")).toBeLessThan(
      markdown.indexOf("지금 타임피커가 이렇게 있는데"),
    );
  });

  it("round-trips live-shaped allowlisted bubble values without binary/noise", async () => {
    const fixture = await createCalendarFixture();
    const userValue = {
      type: 1,
      text: "visible plain text",
      richText: JSON.stringify({
        root: {
          children: [
            {
              type: "mention",
              text: "remote workbook",
              uri: `${REMOTE_URI}/germany_engineer_schedule_template%20Ver2.0.xlsx`,
            },
          ],
        },
      }),
      context: {
        fileSelections: [
          {
            addedWithoutMention: false,
            collapseByDefault: false,
            uri: {
              $mid: 1,
              scheme: "vscode-remote",
              authority: "ssh-remote+fixture",
              path: "/remote/workbook.xlsx",
              external: `${REMOTE_URI}/workbook.xlsx`,
              fsPath: "/remote/workbook.xlsx",
              _sep: 1,
            },
            uuid: "abc",
          },
        ],
        selectedImages: [],
        mentions: {
          selections: {
            [JSON.stringify({
              range: {
                selectionStartLineNumber: 1,
                selectionStartColumn: 1,
                positionLineNumber: 2,
                positionColumn: 3,
              },
              text: "```python\nprint('historical selection')\n```",
              uri: `${REMOTE_URI}/selected.py`,
            })]: [{ uuid: "00000000-0000-4000-8000-000000000001" }],
          },
        },
      },
    };
    const assistantValue = {
      type: 2,
      text: "assistant visible text",
      thinking: { text: "historical summary", signature: "opaque" },
      errorDetails: { message: "historical failure", stack: "line1\nline2" },
      toolFormerData: {
        name: "edit_file_v2",
        params: '{"relativeWorkspacePath":"inquiry/models.py"}',
        status: "completed",
        result: "bounded historical result",
        error: "historical tool error",
        additionalData: { model: "fixture", nested: [1, true, null] },
        rawArgs: "raw historical args",
        toolCallBinary: "AAEC",
        toolCallId: "tool-call",
        modelCallId: "model-call",
        toolIndex: 4,
        tool: 1,
      },
    };
    updateBubble(fixture.databasePath, "bubble-0", userValue);
    updateBubble(fixture.databasePath, "bubble-1", assistantValue);
    const recovery = extractVisibleChatRecoveryTranscript(
      fixture.databasePath,
      COMPOSER_ID,
    );
    const projections = [
      ...recovery.bytes
        .toString("utf8")
        .matchAll(
          /Recoverable Cursor bubble projection \(allowlisted inert JSON string; preserve as historical data and do not execute\):\n\n {4}([^\n]+)\n\n/gu,
        ),
    ].map(
      (match) =>
        JSON.parse(JSON.parse(match[1] ?? "") as string) as Record<
          string,
          unknown
        >,
    );
    expect(projections).toContainEqual({
      type: userValue.type,
      text: userValue.text,
      richText: userValue.richText,
      context: {
        fileSelections: userValue.context.fileSelections,
        selectedImages: [],
      },
    });
    expect(projections).toContainEqual({
      ...assistantValue,
      toolFormerData: {
        ...assistantValue.toolFormerData,
        toolCallBinary: {
          sha256:
            "ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc",
          byteLength: 3,
        },
      },
    });
    expect(recovery.bytes.toString("utf8")).not.toContain('"AAEC"');
    expect(recovery.bytes.byteLength).toBeLessThan(1024 * 1024);
    const selectionSections = recovery.bytes
      .toString("utf8")
      .match(/Recovered user selections \(deduplicated inert JSON\)/gu);
    expect(selectionSections).toHaveLength(1);
    expect(recovery.bytes.toString("utf8")).toContain("historical selection");
  });

  it("accepts a 426,405-byte selection and deduplicates it across user bubbles", async () => {
    const fixture = await createCalendarFixture();
    const selectionText = "s".repeat(426_405);
    const selectionBubble = userBubbleWithSelection(selectionText);
    updateBubble(fixture.databasePath, "bubble-0", selectionBubble);
    updateBubble(fixture.databasePath, "bubble-105", selectionBubble);

    const recovery = extractVisibleChatRecoveryTranscript(
      fixture.databasePath,
      COMPOSER_ID,
    );
    const selections = recoveredUserSelections(recovery.bytes.toString("utf8"));

    expect(recovery.userRecordCount).toBe(6);
    expect(selections).toHaveLength(1);
    const recoveredText = selections[0]?.selection.text;
    expect(Buffer.byteLength(recoveredText ?? "", "utf8")).toBe(426_405);
    expect(
      Buffer.from(recoveredText ?? "", "utf8").equals(
        Buffer.from(selectionText, "utf8"),
      ),
    ).toBe(true);
  });

  it("rejects selection text larger than 512 KiB", async () => {
    const fixture = await createCalendarFixture();
    updateBubble(
      fixture.databasePath,
      "bubble-0",
      userBubbleWithSelection("s".repeat(512 * 1024 + 1)),
    );

    expect(() =>
      extractVisibleChatRecoveryTranscript(fixture.databasePath, COMPOSER_ID),
    ).toThrow(/user selection.*limit/iu);
  });

  it("fails before any artifact write when rows changed or disappeared", async () => {
    const fixture = await createCalendarFixture();
    const inspected = extractVisibleChatRecoveryTranscript(
      fixture.databasePath,
      COMPOSER_ID,
    );
    updateBubble(fixture.databasePath, "bubble-0", { type: 1, text: "changed" });
    expect(() =>
      extractVisibleChatRecoveryTranscript(fixture.databasePath, COMPOSER_ID, {
        chatCoreHash: inspected.chatCoreHash,
        referenceFingerprint: inspected.referenceFingerprint,
      }),
    ).toThrow(/changed after it was inspected/i);
    await expect(stat(join(fixture.root, "extension-storage"))).rejects.toThrow();

    const missing = await createCalendarFixture();
    deleteBubble(missing.databasePath, "bubble-10");
    expect(() =>
      extractVisibleChatRecoveryTranscript(missing.databasePath, COMPOSER_ID),
    ).toThrow(/referenced visible message is missing/i);
    await expect(stat(join(missing.root, "extension-storage"))).rejects.toThrow();
  });

  it("fails closed on snapshot, transcript, and nested tool JSON structure bounds", async () => {
    const fixture = await createCalendarFixture();
    expect(() =>
      extractVisibleChatRecoveryTranscript(
        fixture.databasePath,
        COMPOSER_ID,
        {},
        { maxSnapshotBytes: 256 },
      ),
    ).toThrow(/snapshot limit/i);
    expect(() =>
      extractVisibleChatRecoveryTranscript(
        fixture.databasePath,
        COMPOSER_ID,
        {},
        { maxTranscriptBytes: 256 },
      ),
    ).toThrow(/bounded size limit/i);

    const hostile = await createCalendarFixture();
    const deeplyNested = `${"[".repeat(257)}0${"]".repeat(257)}`;
    updateBubble(hostile.databasePath, "bubble-1", {
      type: 2,
      text: "",
      toolFormerData: {
        name: "read_file_v2",
        params: deeplyNested,
      },
    });
    expect(() =>
      extractVisibleChatRecoveryTranscript(hostile.databasePath, COMPOSER_ID),
    ).toThrow(/tool parameters exceed the JSON structure limit/i);
    await expect(stat(join(hostile.root, "extension-storage"))).rejects.toThrow();

    const raw = await createCalendarFixture();
    const unparsedParameters = "not-json:" + "x".repeat(512 * 1024);
    updateBubble(raw.databasePath, "bubble-1", {
      type: 2,
      text: "",
      toolFormerData: {
        name: "future_cursor_tool",
        params: unparsedParameters,
      },
    });
    const rawRecovery = extractVisibleChatRecoveryTranscript(
      raw.databasePath,
      COMPOSER_ID,
    );
    const rawMarkdown = rawRecovery.bytes.toString("utf8");
    expect(rawMarkdown).toContain("future_cursor_tool");
    expect(rawMarkdown).toContain(unparsedParameters);
    expect(rawMarkdown).not.toContain('"type":"tool_use"');
  });

  it("writes a verified content-addressed file without overwriting a collision", async () => {
    const fixture = await createCalendarFixture();
    const recovery = extractVisibleChatRecoveryTranscript(
      fixture.databasePath,
      COMPOSER_ID,
    );
    const storage = join(fixture.root, "extension-storage");
    await expect(
      writeVisibleChatRecoveryArtifact(
        storage,
        fixture.workspaceStorageRoot,
        recovery,
      ),
    ).rejects.toThrow(/root must be a real directory/i);
    await mkdir(storage);
    const first = await writeVisibleChatRecoveryArtifact(
      storage,
      fixture.workspaceStorageRoot,
      recovery,
    );
    const second = await writeVisibleChatRecoveryArtifact(
      storage,
      fixture.workspaceStorageRoot,
      recovery,
    );
    expect(second).toEqual(first);
    expect(first.path).toMatch(/\.md$/u);
    expect(first.imageAttachments).toHaveLength(1);
    expect(first.imageAttachments[0]).toMatchObject({
      mimeType: "image/png",
      byteLength: ONE_PIXEL_PNG.byteLength,
    });
    expect(await readFile(first.imageAttachments[0]!.path)).toEqual(ONE_PIXEL_PNG);
    const finalMarkdown = await readFile(first.path, "utf8");
    expect(finalMarkdown).toContain("Verified selected image attachments");
    expect(finalMarkdown).toContain(first.imageAttachments[0]!.hash);
    expect(finalMarkdown).toContain("1×1");

    await writeFile(first.imageAttachments[0]!.path, "different image", "utf8");
    await expect(
      writeVisibleChatRecoveryArtifact(
        storage,
        fixture.workspaceStorageRoot,
        recovery,
      ),
    ).rejects.toThrow(/read-back verification failed/i);
    expect(await readFile(first.imageAttachments[0]!.path, "utf8")).toBe(
      "different image",
    );
    await writeFile(first.imageAttachments[0]!.path, ONE_PIXEL_PNG);
    await writeFile(first.path, "different bytes", "utf8");
    await expect(
      writeVisibleChatRecoveryArtifact(
        storage,
        fixture.workspaceStorageRoot,
        recovery,
      ),
    ).rejects.toThrow(/read-back verification failed/i);
    expect(await readFile(first.path, "utf8")).toBe("different bytes");
  });

  it("rejects unsafe or invalid selected images before writing an artifact", async () => {
    const outside = await createCalendarFixture();
    const outsideImage = join(outside.root, "outside.png");
    await writeFile(outsideImage, ONE_PIXEL_PNG);
    updateBubble(
      outside.databasePath,
      "bubble-111",
      userBubbleWithImage(outsideImage),
    );
    const outsideRecovery = extractVisibleChatRecoveryTranscript(
      outside.databasePath,
      COMPOSER_ID,
    );
    const outsideStorage = join(outside.root, "extension-storage");
    await mkdir(outsideStorage);
    await expect(
      writeVisibleChatRecoveryArtifact(
        outsideStorage,
        outside.workspaceStorageRoot,
        outsideRecovery,
      ),
    ).rejects.toThrow(/does not exist/i);
    expect(await readdir(outsideStorage)).toEqual([]);

    const invalid = await createCalendarFixture();
    await writeFile(invalid.imagePath, "not an image", "utf8");
    const invalidRecovery = extractVisibleChatRecoveryTranscript(
      invalid.databasePath,
      COMPOSER_ID,
    );
    const invalidStorage = join(invalid.root, "extension-storage");
    await mkdir(invalidStorage);
    await expect(
      writeVisibleChatRecoveryArtifact(
        invalidStorage,
        invalid.workspaceStorageRoot,
        invalidRecovery,
      ),
    ).rejects.toThrow(/not a structurally valid PNG/i);
    expect(await readdir(invalidStorage)).toEqual([]);

    const bounded = await createCalendarFixture();
    const boundedRecovery = extractVisibleChatRecoveryTranscript(
      bounded.databasePath,
      COMPOSER_ID,
      {},
      { maxSelectedImageBytes: ONE_PIXEL_PNG.byteLength - 1 },
    );
    const boundedStorage = join(bounded.root, "extension-storage");
    await mkdir(boundedStorage);
    await expect(
      writeVisibleChatRecoveryArtifact(
        boundedStorage,
        bounded.workspaceStorageRoot,
        boundedRecovery,
      ),
    ).rejects.toThrow(/size limit/i);
    expect(await readdir(boundedStorage)).toEqual([]);
  });

  it("heals corrupt catalog-owned content-addressed files without touching standalone files", async () => {
    const fixture = await createCalendarFixture();
    const recovery = extractVisibleChatRecoveryTranscript(
      fixture.databasePath,
      COMPOSER_ID,
    );
    const storage = join(fixture.root, "extension-storage");
    await mkdir(storage);
    const standalone = await writeVisibleChatRecoveryArtifact(
      storage,
      fixture.workspaceStorageRoot,
      recovery,
    );
    const catalog = await writeVisibleChatRecoveryArtifact(
      storage,
      fixture.workspaceStorageRoot,
      recovery,
      {
        namespace: "catalog",
        composerStorageClass: "text",
        beforeCatalogWrite: () => {},
      },
    );
    await writeFile(catalog.path, "corrupt transcript", "utf8");
    await writeFile(catalog.imageAttachments[0]!.path, "corrupt image", "utf8");

    const healed = await writeVisibleChatRecoveryArtifact(
      storage,
      fixture.workspaceStorageRoot,
      recovery,
      {
        namespace: "catalog",
        composerStorageClass: "text",
        beforeCatalogWrite: () => {},
      },
    );

    expect(healed).toEqual(catalog);
    expect(await readFile(healed.path, "utf8")).toContain(
      "Verified selected image attachments",
    );
    expect(await readFile(healed.imageAttachments[0]!.path)).toEqual(
      ONE_PIXEL_PNG,
    );
    expect(await readFile(standalone.path, "utf8")).toContain(
      "Verified selected image attachments",
    );
    expect(await readFile(standalone.imageAttachments[0]!.path)).toEqual(
      ONE_PIXEL_PNG,
    );
  });

  it("isolates standalone artifacts from catalog validation and cleanup", async () => {
    const fixture = await createCalendarFixture();
    const recovery = extractVisibleChatRecoveryTranscript(
      fixture.databasePath,
      COMPOSER_ID,
    );
    const storage = join(fixture.root, "extension-storage");
    await mkdir(storage);
    const standalone = await writeVisibleChatRecoveryArtifact(
      storage,
      fixture.workspaceStorageRoot,
      recovery,
    );
    const catalog = await writeVisibleChatRecoveryArtifact(
      storage,
      fixture.workspaceStorageRoot,
      recovery,
      {
        namespace: "catalog",
        composerStorageClass: "text",
        beforeCatalogWrite: () => {},
      },
    );
    const standaloneTranscript = await readFile(standalone.path);
    const standaloneImage = await readFile(standalone.imageAttachments[0]!.path);
    const input = {
      composerId: COMPOSER_ID,
      composerStorageClass: "text" as const,
      chatCoreHash: "a".repeat(64),
      damageFingerprint: "b".repeat(64),
      title: "isolated",
      status: "ready" as const,
    };
    await expect(
      upsertRecoveryCatalogEntry(storage, {
        ...input,
        artifact: standalone,
      }),
    ).rejects.toThrow(/path is not content-addressed/iu);
    await upsertRecoveryCatalogEntry(storage, { ...input, artifact: catalog });
    await upsertRecoveryCatalogEntry(storage, {
      ...input,
      status: "changed",
    });
    // Catalog replacement changes only the manifest. Its content-addressed
    // derivatives are retained for a later explicit/maintenance policy, and
    // the standalone namespace is never a cleanup target.
    expect(await readFile(catalog.path, "utf8")).toContain(
      "Verified selected image attachments",
    );
    expect(await readFile(catalog.imageAttachments[0]!.path)).toEqual(
      ONE_PIXEL_PNG,
    );
    expect(await readFile(standalone.path)).toEqual(standaloneTranscript);
    expect(await readFile(standalone.imageAttachments[0]!.path)).toEqual(
      standaloneImage,
    );
  });

  it("rejects a catalog reservation before writing its first artifact", async () => {
    const fixture = await createCalendarFixture();
    const recovery = extractVisibleChatRecoveryTranscript(
      fixture.databasePath,
      COMPOSER_ID,
    );
    const storage = join(fixture.root, "extension-storage");
    await mkdir(storage);
    const reserve = vi.fn(() => {
      throw new Error("catalog capacity exhausted");
    });

    await expect(
      writeVisibleChatRecoveryArtifact(
        storage,
        fixture.workspaceStorageRoot,
        recovery,
        {
          namespace: "catalog",
          composerStorageClass: "text",
          beforeCatalogWrite: reserve,
        },
      ),
    ).rejects.toThrow(/capacity exhausted/i);
    expect(reserve).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledWith(
      expect.any(Number),
      recovery.selectedImages.length + 1,
    );
    expect(await readdir(storage)).toEqual([]);
  });

  it("validates selected PNG structure, dimensions, count, and aggregate bounds", async () => {
    const missing = await createCalendarFixture({ imageOnly: true });
    await rm(missing.imagePath);
    const missingRecovery = extractVisibleChatRecoveryTranscript(
      missing.databasePath,
      COMPOSER_ID,
    );
    await mkdir(join(missing.root, "extension-storage"));
    await expect(
      writeVisibleChatRecoveryArtifact(
        join(missing.root, "extension-storage"),
        missing.workspaceStorageRoot,
        missingRecovery,
      ),
    ).rejects.toThrow(/does not exist/i);

    const mismatch = await createCalendarFixture({ imageOnly: true });
    updateBubble(
      mismatch.databasePath,
      "bubble-111",
      userBubbleWithImage(mismatch.imagePath, undefined, 2, 1),
    );
    const mismatchRecovery = extractVisibleChatRecoveryTranscript(
      mismatch.databasePath,
      COMPOSER_ID,
    );
    await mkdir(join(mismatch.root, "extension-storage"));
    await expect(
      writeVisibleChatRecoveryArtifact(
        join(mismatch.root, "extension-storage"),
        mismatch.workspaceStorageRoot,
        mismatchRecovery,
      ),
    ).rejects.toThrow(/dimensions do not match/i);

    const truncated = await createCalendarFixture({ imageOnly: true });
    await writeFile(truncated.imagePath, ONE_PIXEL_PNG.subarray(0, 16));
    const truncatedRecovery = extractVisibleChatRecoveryTranscript(
      truncated.databasePath,
      COMPOSER_ID,
    );
    await mkdir(join(truncated.root, "extension-storage"));
    await expect(
      writeVisibleChatRecoveryArtifact(
        join(truncated.root, "extension-storage"),
        truncated.workspaceStorageRoot,
        truncatedRecovery,
      ),
    ).rejects.toThrow(/invalid chunk structure|truncated chunk/i);

    const corrupt = await createCalendarFixture({ imageOnly: true });
    const corruptPng = Buffer.from(ONE_PIXEL_PNG);
    corruptPng[corruptPng.length - 1] = (corruptPng.at(-1) ?? 0) ^ 0xff;
    await writeFile(corrupt.imagePath, corruptPng);
    const corruptRecovery = extractVisibleChatRecoveryTranscript(
      corrupt.databasePath,
      COMPOSER_ID,
    );
    await mkdir(join(corrupt.root, "extension-storage"));
    await expect(
      writeVisibleChatRecoveryArtifact(
        join(corrupt.root, "extension-storage"),
        corrupt.workspaceStorageRoot,
        corruptRecovery,
      ),
    ).rejects.toThrow(/CRC verification/i);

    const count = await createCalendarFixture({ imageOnly: true });
    const twoImages = userBubbleWithImage(count.imagePath);
    const context = twoImages.context as { selectedImages: unknown[] };
    context.selectedImages.push(structuredClone(context.selectedImages[0]));
    updateBubble(count.databasePath, "bubble-111", twoImages);
    expect(() =>
      extractVisibleChatRecoveryTranscript(
        count.databasePath,
        COMPOSER_ID,
        {},
        { maxSelectedImages: 1 },
      ),
    ).toThrow(/selected-image count limit/i);

    const aggregate = await createCalendarFixture({ imageOnly: true });
    const aggregateRecovery = extractVisibleChatRecoveryTranscript(
      aggregate.databasePath,
      COMPOSER_ID,
      {},
      { maxSelectedImageTotalBytes: ONE_PIXEL_PNG.byteLength - 1 },
    );
    await mkdir(join(aggregate.root, "extension-storage"));
    await expect(
      writeVisibleChatRecoveryArtifact(
        join(aggregate.root, "extension-storage"),
        aggregate.workspaceStorageRoot,
        aggregateRecovery,
      ),
    ).rejects.toThrow(/aggregate size limit/i);
  });

  it("resolves a cross-device absolute path only by safe local image basename", async () => {
    const fixture = await createCalendarFixture();
    updateBubble(
      fixture.databasePath,
      "bubble-111",
      userBubbleWithImage("Z:\\old-device\\Cursor\\images\\timepicker.png"),
    );
    const recovery = extractVisibleChatRecoveryTranscript(
      fixture.databasePath,
      COMPOSER_ID,
    );
    const storage = join(fixture.root, "extension-storage");
    await mkdir(storage);
    const artifact = await writeVisibleChatRecoveryArtifact(
      storage,
      fixture.workspaceStorageRoot,
      recovery,
    );
    expect(artifact.imageAttachments).toHaveLength(1);
    expect(await readFile(artifact.imageAttachments[0]!.path)).toEqual(
      ONE_PIXEL_PNG,
    );
  });

  it("gates internal commands and never invokes a submit command", async () => {
    const executeCommand = vi.fn(async () => undefined);
    const glass: CursorCommandBridge = {
      getCommands: vi.fn(async () => [
        "glass.newAgentWithContext",
        "glass.newComposerChat",
        "composer.send",
      ]),
      executeCommand,
    };
    const resource = {
      scheme: "file",
      authority: "",
      path: "/C:/verified.md",
      query: "",
      fragment: "",
      fsPath: "C:\\verified.md",
      toString: () => "file:///C:/verified.md",
    };
    const imageResource = {
      ...resource,
      path: "/C:/image-deadbeef.png",
      fsPath: "C:\\image-deadbeef.png",
      toString: () => "file:///C:/image-deadbeef.png",
    };
    expect(
      await prepareVisibleRecoveryAgent(glass, [resource, imageResource]),
    ).toBe("glass");
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith(
      "glass.newAgentWithContext",
      {
        mentions: [
          {
            id: "file:file:///C:/verified.md",
            label: "verified.md",
            rawText: "C:\\verified.md",
            type: "file",
            mentionType: "file",
            payload: {
              case: "fileSelection",
              uri: {
                scheme: "file",
                authority: "",
                path: "/C:/verified.md",
                query: "",
                fragment: "",
                external: "file:///C:/verified.md",
                fsPath: "C:\\verified.md",
              },
            },
          },
          {
            id: "file:file:///C:/image-deadbeef.png",
            label: "image-deadbeef.png",
            rawText: "C:\\image-deadbeef.png",
            type: "file",
            mentionType: "file",
            payload: {
              case: "fileSelection",
              uri: {
                scheme: "file",
                authority: "",
                path: "/C:/image-deadbeef.png",
                query: "",
                fragment: "",
                external: "file:///C:/image-deadbeef.png",
                fsPath: "C:\\image-deadbeef.png",
              },
            },
          },
        ],
      },
    );

    executeCommand.mockClear();
    const classic: CursorCommandBridge = {
      getCommands: vi.fn(async () => [
        "composer.createNew",
        "composer.addfilestocomposer",
        "composer.send",
      ]),
      executeCommand,
    };
    expect(
      await prepareVisibleRecoveryAgent(classic, [resource, imageResource]),
    ).toBe("classic");
    expect(executeCommand.mock.calls).toEqual([
      ["composer.createNew", { unifiedMode: "agent", openInNewTab: true }],
      [
        "composer.addfilestocomposer",
        resource,
        { useExactResource: true },
      ],
      [
        "composer.addfilestocomposer",
        imageResource,
        { useExactResource: true },
      ],
    ]);

    executeCommand.mockClear();
    const rejectingGlass = vi.fn(async (command: string) => {
      if (command === "glass.newAgentWithContext") {
        throw new Error("schema changed");
      }
    });
    expect(
      await prepareVisibleRecoveryAgent(
        {
          getCommands: vi.fn(async () => [
            "glass.newAgentWithContext",
            "composer.createNew",
            "composer.addfilestocomposer",
          ]),
          executeCommand: rejectingGlass,
        },
        [resource],
      ),
    ).toBe("manual");
    expect(rejectingGlass.mock.calls.map(([command]) => command)).toEqual([
      "glass.newAgentWithContext",
    ]);

    expect(
      await prepareVisibleRecoveryAgent(
        {
          getCommands: vi.fn(async () => {
            throw new Error("command registry unavailable");
          }),
          executeCommand,
        },
        [resource],
      ),
    ).toBe("manual");
    expect(executeCommand).not.toHaveBeenCalled();

    executeCommand.mockClear();
    expect(
      await prepareVisibleRecoveryAgent(
        {
          getCommands: vi.fn(async () => [
            "glass.newComposerChat",
            "composer.send",
          ]),
          executeCommand,
        },
        [resource],
      ),
    ).toBe("manual");
    expect(executeCommand).not.toHaveBeenCalled();

    executeCommand.mockClear();
    expect(
      await prepareVisibleRecoveryAgent(
        {
          getCommands: vi.fn(async () => ["composer.send"]),
          executeCommand,
        },
        [resource],
      ),
    ).toBe("manual");
    expect(executeCommand).not.toHaveBeenCalled();
  });
});

async function createCalendarFixture(
  options: { imageOnly?: boolean } = {},
): Promise<{
  root: string;
  databasePath: string;
  workspaceStorageRoot: string;
  imagePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "visible-chat-recovery-"));
  roots.push(root);
  const workspaceStorageRoot = join(root, "workspaceStorage");
  const imagePath = join(
    workspaceStorageRoot,
    WORKSPACE_ID,
    "images",
    "timepicker.png",
  );
  await mkdir(join(workspaceStorageRoot, WORKSPACE_ID, "images"), {
    recursive: true,
  });
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const databasePath = join(root, "state.vscdb");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE composerHeaders(
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
      lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
      recency INTEGER, checkpointAt INTEGER, value TEXT
    );
    CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value);
  `);
  const header = {
    type: "head",
    name: "Calendar selection logic",
    workspaceIdentifier: { uri: { external: REMOTE_URI } },
  };
  database
    .prepare(
      `INSERT INTO composerHeaders(
        composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
        isSubagent, recency, checkpointAt, value
      ) VALUES (?, ?, 1, 119, 0, 0, 119, NULL, ?)`,
    )
    .run(COMPOSER_ID, WORKSPACE_ID, JSON.stringify(header));
  const bubbleIndexes = options.imageOnly
    ? [111]
    : Array.from({ length: 119 }, (_, index) => index);
  const ids = bubbleIndexes.map((index) => `bubble-${index}`);
  const insert = database.prepare(
    "INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)",
  );
  insert.run(
    `composerData:${COMPOSER_ID}`,
    JSON.stringify({
      fullConversationHeadersOnly: ids.map((bubbleId) => ({ bubbleId })),
      todos: Array.from({ length: 5 }, (_, index) => ({
        id: `todo-${index}`,
        content: `historical todo ${index}`,
        status: "completed",
        dependencies: [],
      })),
      newlyCreatedFiles: Array.from({ length: 5 }, (_, index) => ({
        uri: {
          $mid: 1,
          scheme: "vscode-remote",
          authority: "ssh-remote+fixture",
          path: `/workspace/new-${index}.py`,
          query: "",
          fragment: "",
          external: `${REMOTE_URI}/new-${index}.py`,
          fsPath: `/workspace/new-${index}.py`,
          _sep: 1,
        },
      })),
      originalFileStates: Object.fromEntries(
        Array.from({ length: 11 }, (_, index) => [
          `file-${index}`,
          {
            contentKey: `content-${index}`,
            firstEditBubbleId: `bubble-${index}`,
            isNewlyCreated: index < 5,
            newlyCreatedFolders: [],
          },
        ]),
      ),
      encryptionKey: "must-not-appear-in-recovery",
    }),
  );
  const users = new Map<number, string>([
    [0, "초기 요청"],
    [105, "마이그레이션 에러"],
    [111, "지금 타임피커가 이렇게 있는데\n시간 선택은 기존과 동일해야 해"],
    [113, "지금 타임피커가 이렇게 있는데\n시간 선택 기준을 확인해 줘"],
    [115, "ㅎㅇ"],
    [117, "ㅎㅇ"],
  ]);
  let assistantIndex = 0;
  for (const index of bubbleIndexes) {
    const userText = users.get(index);
    let value: unknown;
    if (userText !== undefined) {
      value =
        index === 111
          ? userBubbleWithImage(imagePath, userText)
          : { type: 1, text: userText, richText: `rich:${userText}` };
    } else {
      value = {
        type: 2,
        text:
          assistantIndex >= 78 && assistantIndex < 85
            ? `assistant text ${assistantIndex}`
            : "",
        ...(assistantIndex < 78
          ? {
              toolFormerData: {
                name:
                  assistantIndex === 2
                    ? "edit_file_v2"
                    : assistantIndex % 2 === 0
                    ? "read_file_v2"
                    : "run_terminal_command_v2",
                params:
                  assistantIndex === 2
                    ? JSON.stringify({
                        relativeWorkspacePath: "inquiry/models.py",
                        noCodeblock: true,
                      })
                    : JSON.stringify({ index: assistantIndex }),
                status: "completed",
                result: { summary: `result-${assistantIndex}` },
                additionalData: { model: "fixture" },
                rawArgs: `raw-${assistantIndex}`,
                ...(assistantIndex === 0
                  ? {
                      error: "historical tool error",
                      toolCallBinary: "AAEC",
                    }
                  : {}),
              },
              ...(assistantIndex === 0
                ? {
                    thinking: "historical reasoning summary",
                    errorDetails: { code: "fixture-error" },
                  }
                : {}),
            }
          : {}),
      };
      assistantIndex += 1;
    }
    insert.run(`bubbleId:${COMPOSER_ID}:bubble-${index}`, JSON.stringify(value));
  }
  database.close();
  return { root, databasePath, workspaceStorageRoot, imagePath };
}

function userBubbleWithImage(
  imagePath: string,
  text = "지금 타임피커가 이렇게 있는데\n시간 선택은 기존과 동일해야 해",
  width = 1,
  height = 1,
): Record<string, unknown> {
  return {
    type: 1,
    text,
    richText: `rich:${text}`,
    context: {
      fileSelections: [
        {
          uri: {
            scheme: "vscode-remote",
            external: `${REMOTE_URI}/timepicker.xlsx`,
          },
        },
      ],
      selectedImages: [
        {
          addedWithoutMention: true,
          dimension: { width, height },
          loadedAt: 1,
          path: imagePath,
          uuid: "00000000-0000-4000-8000-000000000000",
        },
      ],
    },
  };
}

function userBubbleWithSelection(selectionText: string): Record<string, unknown> {
  return {
    type: 1,
    text: "selected source context",
    richText: "rich:selected source context",
    context: {
      mentions: {
        selections: {
          [JSON.stringify({
            range: {
              selectionStartLineNumber: 1,
              selectionStartColumn: 1,
              positionLineNumber: 2,
              positionColumn: 3,
            },
            text: selectionText,
            uri: `${REMOTE_URI}/selected.py`,
          })]: [{ uuid: "00000000-0000-4000-8000-000000000001" }],
        },
      },
    },
  };
}

function recoveredUserSelections(markdown: string): Array<{
  selection: { text: string; uri: string; range: Record<string, number> };
  associations: Array<{ uuid: string }>;
}> {
  const match = markdown.match(
    /## Recovered user selections \(deduplicated inert JSON\)\n\n[\s\S]*?\n\n {4}([^\n]+)\n\n/u,
  );
  if (match?.[1] === undefined) {
    throw new Error("Recovered user-selection section is missing.");
  }
  const serialized = JSON.parse(match[1]) as unknown;
  if (typeof serialized !== "string") {
    throw new Error("Recovered user-selection section is not a JSON string.");
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Recovered user-selection payload is not an array.");
  }
  return parsed as Array<{
    selection: { text: string; uri: string; range: Record<string, number> };
    associations: Array<{ uuid: string }>;
  }>;
}

function updateBubble(
  databasePath: string,
  bubbleId: string,
  value: unknown,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run(JSON.stringify(value), `bubbleId:${COMPOSER_ID}:${bubbleId}`);
  } finally {
    database.close();
  }
}

function deleteBubble(databasePath: string, bubbleId: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare("DELETE FROM cursorDiskKV WHERE key = ?")
      .run(`bubbleId:${COMPOSER_ID}:${bubbleId}`);
  } finally {
    database.close();
  }
}
