import { EVENT_EXTENSION, OBJECT_EXTENSION } from "../constants";

export function isRepositoryPayloadFile(fileName: string): boolean {
  const normalized = fileName.replaceAll("\\", "/").toLowerCase();
  return (
    !normalized.includes("sync-conflict") &&
    (normalized.endsWith(EVENT_EXTENSION) || normalized.endsWith(OBJECT_EXTENSION))
  );
}
