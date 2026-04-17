import { describe, expect, test } from "bun:test";
import { computeNodeCentrality } from "./centrality";

describe("computeNodeCentrality", () => {
  test("ranks the middle of a chain above the leaves", () => {
    const centrality = computeNodeCentrality([
      { from_search_id: 1, to_search_id: 2, weight: 1 },
      { from_search_id: 2, to_search_id: 3, weight: 1 },
    ]);

    expect((centrality.get(2) ?? 0)).toBeGreaterThan(centrality.get(1) ?? 0);
    expect((centrality.get(2) ?? 0)).toBeGreaterThan(centrality.get(3) ?? 0);
  });

  test("prefers nodes connected by stronger links", () => {
    const centrality = computeNodeCentrality([
      { from_search_id: 1, to_search_id: 2, weight: 3 },
      { from_search_id: 2, to_search_id: 3, weight: 3 },
      { from_search_id: 3, to_search_id: 4, weight: 0.5 },
    ]);

    expect((centrality.get(2) ?? 0)).toBeGreaterThan(centrality.get(4) ?? 0);
    expect((centrality.get(3) ?? 0)).toBeGreaterThan(centrality.get(4) ?? 0);
  });

  test("returns an empty map when no usable links exist", () => {
    expect(computeNodeCentrality([]).size).toBe(0);
    expect(computeNodeCentrality([{ from_search_id: 1, to_search_id: 2, weight: 0 }]).size).toBe(0);
  });
});
