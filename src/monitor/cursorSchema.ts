import ts from "typescript";
import { createReadStream } from "node:fs";
import { AGENT_KV_SCHEMAS } from "../chat/agentKv";

export const CURSOR_MESSAGE_NAMES = {
  "conversation-state": "agent.v1.ConversationStateStructure",
  "file-state": "agent.v1.FileStateStructure",
  "subagent-state": "agent.v1.SubagentPersistedState",
  "conversation-turn": "agent.v1.ConversationTurnStructure",
  "agent-turn": "agent.v1.AgentConversationTurnStructure",
  "shell-turn": "agent.v1.ShellConversationTurnStructure",
  "user-message": "agent.v1.UserMessage",
  "selected-context": "agent.v1.SelectedContext",
  "selected-image": "agent.v1.SelectedImage",
  "extra-context-entry": "agent.v1.ExtraContextEntry",
  "invocation-context": "agent.v1.InvocationContext",
  "selected-pull-request": "agent.v1.SelectedPullRequest",
  "selected-git-pr-diff": "agent.v1.SelectedGitPRDiffSelection",
  "conversation-step": "agent.v1.ConversationStep",
  "tool-call": "agent.v1.ToolCall",
  "read-tool-call": "agent.v1.ReadToolCall",
  "read-tool-result": "agent.v1.ReadToolResult",
  "read-tool-success": "agent.v1.ReadToolSuccess",
  "task-tool-call": "agent.v1.TaskToolCall",
  "task-result": "agent.v1.TaskResult",
  "task-success": "agent.v1.TaskSuccess",
  "truncated-tool-call": "agent.v1.TruncatedToolCall",
} as const satisfies Record<keyof typeof AGENT_KV_SCHEMAS, string>;

export const MONITORED_CURSOR_MESSAGES = [
  ...Object.values(CURSOR_MESSAGE_NAMES),
  "agent.v1.SelectedImage.BlobIdWithData",
];

type DescriptorValue = string | number | boolean | DescriptorObject;
interface DescriptorObject { [key: string]: DescriptorValue }
export interface CursorField extends DescriptorObject {
  no: number;
  name: string;
  kind: string;
}
export interface CursorSchemaSnapshot {
  formatVersion: 1;
  messages: Record<string, CursorField[]>;
}
export interface CursorSchemaChange {
  message: string;
  field: number | null;
  kind: "added" | "removed" | "changed";
  before?: CursorField;
  after?: CursorField;
}
export interface CursorSchemaGap {
  message: string;
  field: number;
  name: string;
  reason: string;
}

const FIELD_PROPERTIES = new Set([
  "no", "name", "kind", "T", "K", "V", "repeated", "opt", "oneof",
  "packed", "localName", "jsonName", "delimited",
]);

export function extractCursorSchema(source: string): CursorSchemaSnapshot {
  const symbols = new Map<string, string>();
  const definitions = new Map<string, number>();
  const pattern = /([\w$]+)\s*=\s*[\w$]+\.make(MessageType|Enum)\(\s*["']([^"']+)["']\s*,/g;
  for (const match of source.matchAll(pattern)) {
    const symbol = match[1]!;
    const name = match[3]!;
    if (symbols.has(symbol) && symbols.get(symbol) !== name) {
      throw new Error(`Ambiguous protobuf symbol ${symbol}`);
    }
    symbols.set(symbol, name);
    if (match[2] === "MessageType") {
      if (definitions.has(name)) throw new Error(`Duplicate descriptor ${name}`);
      definitions.set(name, match.index + match[0].length);
    }
  }
  const messages: CursorSchemaSnapshot["messages"] = {};
  for (const name of MONITORED_CURSOR_MESSAGES) {
    const start = definitions.get(name);
    if (start === undefined) throw new Error(`Missing protobuf descriptor ${name}`);
    const array = readDescriptorArray(source, start, name);
    const fields = array.elements.map((node) => parseField(node, symbols));
    const numbers = new Set<number>();
    for (const field of fields) {
      if (numbers.has(field.no)) throw new Error(`Duplicate field ${name}#${field.no}`);
      numbers.add(field.no);
    }
    messages[name] = fields.sort((a, b) => a.no - b.no);
  }
  return { formatVersion: 1, messages };
}

function readDescriptorArray(source: string, start: number, name: string): ts.ArrayLiteralExpression {
  const tail = source.slice(start, start + 256_000);
  const prefix = /^\s*(?:\(\s*\)\s*=>\s*)?\[/.exec(tail);
  if (prefix === null) throw new Error(`Unsupported descriptor syntax ${name}`);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, tail);
  scanner.setTextPos(prefix[0].length - 1);
  let depth = 0;
  let end = -1;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.OpenBracketToken) depth += 1;
    if (token === ts.SyntaxKind.CloseBracketToken && --depth === 0) {
      end = scanner.getTextPos();
      break;
    }
  }
  if (end < 0) throw new Error(`Unterminated descriptor ${name}`);
  const parsed = ts.createSourceFile("descriptor.js", `const fields=${tail.slice(prefix[0].length - 1, end)};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const statement = parsed.statements[0];
  const initializer = statement !== undefined && ts.isVariableStatement(statement)
    ? statement.declarationList.declarations[0]?.initializer : undefined;
  if (initializer === undefined || !ts.isArrayLiteralExpression(initializer)) {
    throw new Error(`Invalid descriptor array ${name}`);
  }
  return initializer;
}

function parseField(node: ts.Node, symbols: ReadonlyMap<string, string>): CursorField {
  if (!ts.isObjectLiteralExpression(node)) throw new Error("Non-literal protobuf field");
  const field = parseObject(node, symbols);
  if (!Number.isSafeInteger(field.no) || Number(field.no) < 1 ||
    typeof field.name !== "string" || !field.name ||
    typeof field.kind !== "string" || !["scalar", "enum", "message", "map"].includes(field.kind)) {
    throw new Error("Invalid protobuf field descriptor");
  }
  return field as CursorField;
}

function parseObject(node: ts.ObjectLiteralExpression, symbols: ReadonlyMap<string, string>): DescriptorObject {
  const result: DescriptorObject = {};
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
      throw new Error("Unsupported protobuf property syntax");
    }
    const key = property.name.text;
    if (!FIELD_PROPERTIES.has(key) || Object.hasOwn(result, key)) {
      throw new Error(`Unsupported or duplicate protobuf property ${key}`);
    }
    result[key] = parseValue(property.initializer, symbols);
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function parseValue(node: ts.Expression, symbols: ReadonlyMap<string, string>): DescriptorValue {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && ts.isNumericLiteral(node.operand)) {
    return !Number(node.operand.text);
  }
  if (ts.isObjectLiteralExpression(node)) return parseObject(node, symbols);
  let symbol: string | undefined;
  if (ts.isIdentifier(node)) symbol = node.text;
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "getEnumType" && node.arguments.length === 1) {
    const argument = node.arguments[0];
    if (argument !== undefined && ts.isIdentifier(argument)) symbol = argument.text;
  }
  if (symbol !== undefined && symbols.has(symbol)) return symbols.get(symbol)!;
  throw new Error(`Unsupported protobuf value: ${node.getText().slice(0, 100)}`);
}

export function validateCursorSnapshot(value: unknown): asserts value is CursorSchemaSnapshot {
  if (typeof value !== "object" || value === null || !("formatVersion" in value) ||
    value.formatVersion !== 1 || !("messages" in value) || typeof value.messages !== "object" || value.messages === null) {
    throw new Error("Invalid Cursor schema baseline");
  }
  for (const name of MONITORED_CURSOR_MESSAGES) {
    const fields: unknown = (value.messages as Record<string, unknown>)[name];
    if (!Array.isArray(fields) || fields.length === 0) throw new Error(`Missing baseline descriptor ${name}`);
    const numbers = new Set<number>();
    for (const entry of fields) {
      const field: unknown = entry;
      if (typeof field !== "object" || field === null || !("no" in field) ||
        !Number.isSafeInteger(field.no) || Number(field.no) < 1 || numbers.has(Number(field.no)) ||
        !("name" in field) || typeof field.name !== "string" || !field.name ||
        !("kind" in field) || !["scalar", "enum", "message", "map"].includes(String(field.kind))) {
        throw new Error(`Invalid baseline field ${name}`);
      }
      numbers.add(Number(field.no));
    }
  }
}

export function compareCursorSchemas(before: CursorSchemaSnapshot, after: CursorSchemaSnapshot): CursorSchemaChange[] {
  const changes: CursorSchemaChange[] = [];
  for (const message of [...new Set([...Object.keys(before.messages), ...Object.keys(after.messages)])].sort()) {
    const previous = before.messages[message];
    const current = after.messages[message];
    if (previous === undefined || current === undefined) {
      changes.push({ message, field: null, kind: previous === undefined ? "added" : "removed" });
      continue;
    }
    const oldFields = new Map(previous.map((field) => [field.no, field]));
    const newFields = new Map(current.map((field) => [field.no, field]));
    for (const field of [...new Set([...oldFields.keys(), ...newFields.keys()])].sort((a, b) => a - b)) {
      const oldValue = oldFields.get(field);
      const newValue = newFields.get(field);
      if (oldValue === undefined) changes.push({ message, field, kind: "added", after: newValue! });
      else if (newValue === undefined) changes.push({ message, field, kind: "removed", before: oldValue });
      else if (canonicalDescriptor(oldValue) !== canonicalDescriptor(newValue)) {
        changes.push({ message, field, kind: "changed", before: oldValue, after: newValue });
      }
    }
  }
  return changes;
}

export function findCursorSchemaGaps(snapshot: CursorSchemaSnapshot): CursorSchemaGap[] {
  const gaps: CursorSchemaGap[] = [];
  for (const schema of Object.keys(CURSOR_MESSAGE_NAMES) as (keyof typeof CURSOR_MESSAGE_NAMES)[]) {
    const message = CURSOR_MESSAGE_NAMES[schema];
    const rules = AGENT_KV_SCHEMAS[schema].fields;
    for (const field of snapshot.messages[message] ?? []) {
      const rule = rules[field.no];
      const wires = descriptorWires(field);
      const accepted = rule === undefined ? [] : typeof rule.wire === "number" ? [rule.wire] : rule.wire;
      const action = rule?.action;
      const actionMismatch = action?.kind === "reference"
        ? field.kind !== "scalar" || field.T !== 12
        : action?.kind === "message"
          ? field.kind !== "message" || field.T !== CURSOR_MESSAGE_NAMES[action.schema]
          : action?.kind === "map-reference"
            ? field.kind !== "map" || field.K !== 9 || typeof field.V !== "object" || field.V.kind !== "scalar" || field.V.T !== 12
            : action?.kind === "map-message"
              ? field.kind !== "map" || field.K !== 9 || typeof field.V !== "object" || field.V.kind !== "message" || field.V.T !== CURSOR_MESSAGE_NAMES[action.schema]
              : action?.kind === "selected-image-with-data"
                ? field.kind !== "message" || field.T !== "agent.v1.SelectedImage.BlobIdWithData" : false;
      const reason = rule === undefined ? "Field is not supported by the continuation parser"
        : wires.some((wire) => !accepted.includes(wire)) ? "Wire type is not supported by the continuation parser"
        : actionMismatch ? "Reference or embedded message no longer matches the continuation parser"
        : null;
      if (reason !== null) gaps.push({ message, field: field.no, name: field.name, reason });
    }
  }
  const imageMessage = "agent.v1.SelectedImage.BlobIdWithData";
  for (const field of snapshot.messages[imageMessage] ?? []) {
    if (![1, 2].includes(field.no) || field.kind !== "scalar" || field.T !== 12) {
      gaps.push({ message: imageMessage, field: field.no, name: field.name, reason: "Field is not supported by the embedded image parser" });
    }
  }
  return gaps;
}

function canonicalDescriptor(value: DescriptorValue): string {
  return typeof value === "object"
    ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalDescriptor(entry)}`).join(",")}}`
    : JSON.stringify(value);
}

function descriptorWires(field: CursorField): number[] {
  if (field.kind === "message" || field.kind === "map") return [2];
  const scalar = field.kind === "enum" ? 14 : field.T;
  if (typeof scalar !== "number") throw new Error("Unknown non-numeric protobuf scalar type");
  let wire: number;
  if (scalar === 9 || scalar === 12) wire = 2;
  else if ([1, 6, 16].includes(Number(scalar))) wire = 1;
  else if ([2, 7, 15].includes(Number(scalar))) wire = 5;
  else if ([3, 4, 5, 8, 13, 14, 17, 18].includes(Number(scalar))) wire = 0;
  else throw new Error(`Unknown scalar type ${scalar}`);
  return field.repeated === true && wire !== 2 ? [wire, 2] : [wire];
}

export async function findSquashfsOffset(path: string): Promise<number> {
  let previous = Buffer.alloc(0);
  let position = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected archive stream chunk");
    const block = Buffer.concat([previous, chunk]);
    for (let offset = block.indexOf("hsqs"); offset >= 0; offset = block.indexOf("hsqs", offset + 1)) {
      if (offset + 32 <= block.length && block.readUInt16LE(offset + 28) === 4 && block.readUInt16LE(offset + 30) === 0) return position - previous.length + offset;
    }
    position += chunk.length;
    previous = block.subarray(Math.max(0, block.length - 32));
  }
  throw new Error("Cursor AppImage has no recognized SquashFS v4 archive");
}
