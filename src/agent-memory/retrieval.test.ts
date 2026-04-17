import { describe, expect, test } from "bun:test";
import { estimateTokenCost, selectBudgetedRows } from "./retrieval";

describe("retrieval budgeting", () => {
  test("estimates non-zero token cost", () => {
    expect(estimateTokenCost("tiny")).toBeGreaterThan(0);
  });

  test("packs rows until the token budget is exhausted", () => {
    const rows = [
      { id: 1, content: "a".repeat(80) },
      { id: 2, content: "b".repeat(80) },
      { id: 3, content: "c".repeat(80) },
    ];

    const result = selectBudgetedRows(rows, 70);
    expect(result.rows.map((row) => row.id)).toEqual([1, 2]);
    expect(result.tokensUsed).toBeLessThanOrEqual(70);
    expect(result.dropped).toBe(1);
  });

  test("still returns the top row when it alone exceeds the budget", () => {
    const rows = [
      { id: 1, content: "a".repeat(400) },
      { id: 2, content: "b".repeat(20) },
    ];

    const result = selectBudgetedRows(rows, 32);
    expect(result.rows.map((row) => row.id)).toEqual([1]);
    expect(result.dropped).toBe(1);
  });
});
