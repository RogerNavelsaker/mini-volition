export type LinkRow = {
  from_search_id: number;
  to_search_id: number;
  weight: number;
};

export function computeNodeCentrality(
  linkRows: LinkRow[],
  iterations = 12,
  damping = 0.85,
): Map<number, number> {
  const nodes = new Set<number>();
  const neighbors = new Map<number, Array<{ id: number; weight: number }>>();

  for (const row of linkRows) {
    const weight = Math.max(0, row.weight);
    if (weight <= 0) continue;
    nodes.add(row.from_search_id);
    nodes.add(row.to_search_id);
    const fromNeighbors = neighbors.get(row.from_search_id) ?? [];
    fromNeighbors.push({ id: row.to_search_id, weight });
    neighbors.set(row.from_search_id, fromNeighbors);
    const toNeighbors = neighbors.get(row.to_search_id) ?? [];
    toNeighbors.push({ id: row.from_search_id, weight });
    neighbors.set(row.to_search_id, toNeighbors);
  }

  if (nodes.size === 0) return new Map();

  const ids = Array.from(nodes);
  const base = (1 - damping) / ids.length;
  let scores = new Map(ids.map((id) => [id, 1 / ids.length]));

  for (let step = 0; step < iterations; step += 1) {
    const next = new Map(ids.map((id) => [id, base]));
    for (const id of ids) {
      const nodeScore = scores.get(id) ?? 0;
      const outgoing = neighbors.get(id) ?? [];
      const totalWeight = outgoing.reduce((sum, edge) => sum + edge.weight, 0);
      if (outgoing.length === 0 || totalWeight <= 0) {
        const shared = damping * nodeScore / ids.length;
        for (const target of ids) next.set(target, (next.get(target) ?? 0) + shared);
        continue;
      }
      for (const edge of outgoing) {
        const contribution = damping * nodeScore * (edge.weight / totalWeight);
        next.set(edge.id, (next.get(edge.id) ?? 0) + contribution);
      }
    }
    scores = next;
  }

  const maxScore = Math.max(...Array.from(scores.values()), 0);
  if (maxScore <= 0) return new Map(ids.map((id) => [id, 0]));
  return new Map(ids.map((id) => [id, (scores.get(id) ?? 0) / maxScore]));
}
