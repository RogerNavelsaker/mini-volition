import type { LinkedLookupRow } from "./types";

export function applyLinkedBudget(rows: LinkedLookupRow[], budgetChars: number): LinkedLookupRow[] {
  let accumulated = 0;
  return rows.filter((row) => {
    if (accumulated >= budgetChars) return false;
    accumulated += row.reflection.length;
    return true;
  });
}
