import type {
  LocalProjection,
  ResourceDeletion,
  ResourceKind,
  ResourceScanResult,
  ResourceSnapshot,
} from "../types";

export type ResourceApplyInput = ResourceSnapshot | ResourceDeletion;

export interface RetainedLocalApplyResult {
  status: "retained-local";
  semanticHash: string;
}

export type ResourceApplyResult = void | RetainedLocalApplyResult;

export interface ResourceAdapter {
  readonly id: string;
  readonly kinds: readonly ResourceKind[];
  readonly appliesWhileRunning: boolean;
  readonly scanWhileRunning?: boolean;

  scan(known: Record<string, LocalProjection>): Promise<ResourceScanResult>;
  apply(input: ResourceApplyInput): Promise<ResourceApplyResult>;
}

export function isDeletion(input: ResourceApplyInput): input is ResourceDeletion {
  return !("content" in input);
}
