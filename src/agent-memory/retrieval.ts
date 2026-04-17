export type BudgetableRow = {
  id: number;
  content: string;
  score?: number;
};

export function estimateTokenCost(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4) + 12);
}

export function selectBudgetedRows<T extends BudgetableRow>(
  rows: T[],
  tokenBudget: number,
): { rows: T[]; tokensUsed: number; dropped: number } {
  const budget = Math.max(32, tokenBudget);
  const selected: T[] = [];
  let used = 0;

  for (const row of rows) {
    const rowCost = estimateTokenCost(row.content);
    if (selected.length > 0 && used + rowCost > budget) continue;
    selected.push(row);
    used += rowCost;
    if (used >= budget) break;
  }

  if (selected.length === 0 && rows.length > 0) {
    const first = rows[0]!;
    return {
      rows: [first],
      tokensUsed: estimateTokenCost(first.content),
      dropped: Math.max(0, rows.length - 1),
    };
  }

  return {
    rows: selected,
    tokensUsed: used,
    dropped: Math.max(0, rows.length - selected.length),
  };
}
