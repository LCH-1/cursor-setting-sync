import { readFileSync, statSync } from "node:fs";
import {
  captureChatRecoveryProbe,
  findChatRecoverySuccessor,
  type ChatRecoveryProbe,
} from "../src/chat/recoveryProbe";

interface ParsedArguments {
  databasePath: string;
  composerId: string;
  baselinePath?: string;
  findSuccessorAfter?: number;
  expectedUserTextHashes: string[];
  maxCandidates?: number;
  snapshotByteLimit?: number;
}

interface BaselineDocument {
  schemaVersion: 1;
  original: ChatRecoveryProbe;
}

async function main(): Promise<void> {
  const captureStartedAt = Date.now();
  const options = parseArguments(process.argv.slice(2));
  const original = await captureChatRecoveryProbe(
    options.databasePath,
    options.composerId,
    options.snapshotByteLimit === undefined
      ? {}
      : { snapshotByteLimit: options.snapshotByteLimit },
  );
  const baseline =
    options.baselinePath === undefined
      ? null
      : readBaseline(options.baselinePath, options.composerId);
  const originalComparison =
    baseline === null ? null : compareOriginal(baseline.original, original);
  const successorSearch =
    options.findSuccessorAfter === undefined
      ? null
      : await findChatRecoverySuccessor(
          options.databasePath,
          options.composerId,
          {
            createdAfter: options.findSuccessorAfter,
            expectedUserTextHashes: options.expectedUserTextHashes,
            ...(options.maxCandidates === undefined
              ? {}
              : { maxCandidates: options.maxCandidates }),
            ...(options.snapshotByteLimit === undefined
              ? {}
              : { snapshotByteLimit: options.snapshotByteLimit }),
          },
        );
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      captureStartedAt,
      original,
      originalComparison,
      successorSearch,
    })}\n`,
  );
}

function parseArguments(arguments_: readonly string[]): ParsedArguments {
  let databasePath: string | undefined;
  let composerId: string | undefined;
  let baselinePath: string | undefined;
  let findSuccessorAfter: number | undefined;
  let maxCandidates: number | undefined;
  let snapshotByteLimit: number | undefined;
  const expectedUserTextHashes: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${name ?? "an argument"}.`);
    }
    index += 1;
    switch (name) {
      case "--db":
        databasePath = value;
        break;
      case "--composer":
        composerId = value;
        break;
      case "--baseline":
        baselinePath = value;
        break;
      case "--find-successor-after":
        findSuccessorAfter = parseNonnegativeInteger(name, value);
        break;
      case "--expected-user-hash":
        expectedUserTextHashes.push(value);
        break;
      case "--max-candidates":
        maxCandidates = parsePositiveInteger(name, value);
        break;
      case "--snapshot-mib":
        snapshotByteLimit =
          parsePositiveInteger(name, value) * 1024 * 1024;
        if (!Number.isSafeInteger(snapshotByteLimit)) {
          throw new Error("--snapshot-mib is too large.");
        }
        break;
      default:
        throw new Error(`Unknown argument ${name ?? ""}.`);
    }
  }
  if (databasePath === undefined || composerId === undefined) {
    throw new Error("--db and --composer are required.");
  }
  if (
    findSuccessorAfter !== undefined &&
    expectedUserTextHashes.length < 2
  ) {
    throw new Error(
      "Successor identification requires the SHA-256 hashes of both test prompts.",
    );
  }
  return {
    databasePath,
    composerId,
    expectedUserTextHashes,
    ...(baselinePath === undefined ? {} : { baselinePath }),
    ...(findSuccessorAfter === undefined ? {} : { findSuccessorAfter }),
    ...(maxCandidates === undefined ? {} : { maxCandidates }),
    ...(snapshotByteLimit === undefined ? {} : { snapshotByteLimit }),
  };
}

function readBaseline(path: string, composerId: string): BaselineDocument {
  if (statSync(path).size > 1024 * 1024) {
    throw new Error("The baseline JSON exceeds its 1 MiB safety limit.");
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new Error("The baseline JSON has an unsupported shape.");
  }
  const original = (parsed as { original?: unknown }).original;
  if (
    original === null ||
    typeof original !== "object" ||
    Array.isArray(original) ||
    (original as { composerId?: unknown }).composerId !== composerId ||
    typeof (original as { probeFingerprint?: unknown }).probeFingerprint !==
      "string"
  ) {
    throw new Error("The baseline does not describe the requested composer.");
  }
  return parsed as BaselineDocument;
}

function compareOriginal(
  baseline: ChatRecoveryProbe,
  current: ChatRecoveryProbe,
): Record<string, boolean> {
  return {
    unchanged: baseline.probeFingerprint === current.probeFingerprint,
    headerUnchanged:
      baseline.headerFingerprint === current.headerFingerprint,
    composerDataUnchanged:
      baseline.composerDataFingerprint === current.composerDataFingerprint,
    referencesUnchanged:
      baseline.referenceFingerprint === current.referenceFingerprint,
    coreUnchanged: baseline.coreFingerprint === current.coreFingerprint,
    agentKvUnchanged:
      baseline.agentKv.status === current.agentKv.status &&
      (baseline.agentKv.status === "known" && current.agentKv.status === "known"
        ? baseline.agentKv.fingerprint === current.agentKv.fingerprint
        : JSON.stringify(baseline.agentKv) === JSON.stringify(current.agentKv)),
  };
}

function parsePositiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

function parseNonnegativeInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return parsed;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
