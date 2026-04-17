import { describe, expect, test } from "bun:test";
import { matchEntityToItem } from "./facts";

describe("matchEntityToItem", () => {
  const items = [
    { id: 1, item_kind: "decision", content: "Use bun standalone executables for release artifacts in GitHub Actions." },
    { id: 2, item_kind: "fact", content: "flake.nix provides reproducible source builds for Nix users." },
    { id: 3, item_kind: "pattern", content: "Local inference workers expose unix sockets in runtime/ for orchestration." },
  ];

  test("prefers the item containing both subject and object phrases", () => {
    const match = matchEntityToItem(items, {
      subject: "flake.nix",
      predicate: "provides",
      object: "reproducible source builds",
      description: "flake.nix provides reproducible source builds for Nix users",
    });

    expect(match?.id).toBe(2);
  });

  test("uses token overlap when the extracted tuple paraphrases the source line", () => {
    const match = matchEntityToItem(items, {
      subject: "GitHub Actions",
      predicate: "uses",
      object: "bun standalone executables",
      description: "release artifacts should be built with bun standalone executables in GitHub Actions",
    });

    expect(match?.id).toBe(1);
  });

  test("returns null when no item is a credible match", () => {
    const match = matchEntityToItem(items, {
      subject: "SQLite WAL mode",
      predicate: "improves",
      object: "write concurrency",
      description: "sqlite write concurrency configuration",
    });

    expect(match).toBeNull();
  });
});
