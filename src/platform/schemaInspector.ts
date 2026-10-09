import { parentPort, workerData } from "node:worker_threads";
import { extractCursorSchema } from "../monitor/cursorSchema";
import { encodeCursorDataSchema, readCursorWorkbench } from "./cursorDataSchema";

void (async () => {
  try {
    const schema = extractCursorSchema(await readCursorWorkbench(String(workerData)), true);
    parentPort?.postMessage({ schema: encodeCursorDataSchema(schema) });
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
})();
