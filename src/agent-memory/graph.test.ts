import { describe, it, expect } from "bun:test";
import { applyLinkedBudget } from "./graph";
import type { LinkedLookupRow } from "./types";

function row(reflection: string, weight = 1.0): LinkedLookupRow {
  return { id: Math.random(), relation: "related", weight, reflection };
}

describe("applyLinkedBudget", () => {
  it("returns empty array when given empty input", () => {
    expect(applyLinkedBudget([], 1000)).toEqual([]);
  });

  it("includes all rows when total chars are under budget", () => {
    const rows = [row("abc"), row("def"), row("ghi")];
    expect(applyLinkedBudget(rows, 100)).toHaveLength(3);
  });

  it("stops including rows once budget is exhausted", () => {
    const rows = [row("a".repeat(100)), row("b".repeat(100)), row("c".repeat(100))];
    const result = applyLinkedBudget(rows, 150);
    expect(result).toHaveLength(2);
    expect(result[0].reflection).toBe("a".repeat(100));
    expect(result[1].reflection).toBe("b".repeat(100));
  });

  it("includes a row that exactly fills the budget", () => {
    const rows = [row("a".repeat(100)), row("extra")];
    const result = applyLinkedBudget(rows, 100);
    expect(result).toHaveLength(1);
  });

  it("returns the first row even when it alone exceeds budget", () => {
    const rows = [row("a".repeat(500)), row("b")];
    const result = applyLinkedBudget(rows, 100);
    expect(result).toHaveLength(1);
    expect(result[0].reflection).toBe("a".repeat(500));
  });

  it("returns empty array when budget is 0", () => {
    const rows = [row("hello"), row("world")];
    const result = applyLinkedBudget(rows, 0);
    expect(result).toHaveLength(0);
  });
});
