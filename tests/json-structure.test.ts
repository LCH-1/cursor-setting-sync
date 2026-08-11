import { describe, expect, it } from "vitest";
import {
  buffersFitJsonStructureBudget,
  createJsonStructureBudget,
} from "../src/protocol/jsonStructure";

describe("JSON structural budget", () => {
  it("accepts ordinary strict JSON punctuation without treating separators as closers", () => {
    expect(
      buffersFitJsonStructureBudget([Buffer.from('{"a":1,"b":[]}', "utf8")]),
    ).toBe(true);
  });

  it("shares one token budget across incrementally decoded documents", () => {
    const budget = createJsonStructureBudget({ maxStructuralTokens: 8 });

    expect(budget.consume("[0,0]")).toBe(true);
    expect(budget.consume("[0,0]")).toBe(true);
    expect(budget.consume("[0]")).toBe(false);
  });
});
