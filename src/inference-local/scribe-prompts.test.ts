import { describe, it, expect } from "bun:test";
import { buildScribePrompt } from "./scribe-prompts";

describe("buildScribePrompt — roamer", () => {
  it("contains the task text", () => {
    const prompt = buildScribePrompt("roamer", "investigate the memory system");
    expect(prompt).toContain("investigate the memory system");
  });

  it("contains roamer identity", () => {
    const prompt = buildScribePrompt("roamer", "task");
    expect(prompt).toContain("Roamer");
  });

  it("emphasizes read-only investigation", () => {
    const prompt = buildScribePrompt("roamer", "task");
    expect(prompt).toContain("read-only");
  });

  it("mentions exploration or research", () => {
    const prompt = buildScribePrompt("roamer", "task");
    expect(prompt.toLowerCase()).toMatch(/exploration|research|investigat/);
  });

  it("instructs to return findings not take action", () => {
    const prompt = buildScribePrompt("roamer", "task");
    expect(prompt.toLowerCase()).toMatch(/findings|report/);
  });
});

describe("buildScribePrompt — homer", () => {
  it("contains the task text", () => {
    const prompt = buildScribePrompt("homer", "extract entities from this doc");
    expect(prompt).toContain("extract entities from this doc");
  });

  it("contains homer identity", () => {
    const prompt = buildScribePrompt("homer", "task");
    expect(prompt).toContain("Homer");
  });

  it("mentions memory curation or entity extraction", () => {
    const prompt = buildScribePrompt("homer", "task");
    expect(prompt.toLowerCase()).toMatch(/memory|entity|fact/);
  });
});

describe("buildScribePrompt — riker", () => {
  it("contains the task text", () => {
    const prompt = buildScribePrompt("riker", "recommend the best approach");
    expect(prompt).toContain("recommend the best approach");
  });

  it("contains riker identity", () => {
    const prompt = buildScribePrompt("riker", "task");
    expect(prompt).toContain("Riker");
  });

  it("mentions decision or tradeoff", () => {
    const prompt = buildScribePrompt("riker", "task");
    expect(prompt.toLowerCase()).toMatch(/decision|tradeoff|proposal/);
  });

  it("asks for concrete recommendation", () => {
    const prompt = buildScribePrompt("riker", "task");
    expect(prompt.toLowerCase()).toMatch(/recommendation|concrete/);
  });
});

describe("buildScribePrompt — milo", () => {
  it("contains the task text", () => {
    const prompt = buildScribePrompt("milo", "validate the output");
    expect(prompt).toContain("validate the output");
  });

  it("contains milo identity", () => {
    const prompt = buildScribePrompt("milo", "task");
    expect(prompt).toContain("Milo");
  });

  it("mentions validation or testing", () => {
    const prompt = buildScribePrompt("milo", "task");
    expect(prompt.toLowerCase()).toMatch(/validat|test|smoke/);
  });
});

describe("buildScribePrompt — scribe (default)", () => {
  it("contains the task text", () => {
    const prompt = buildScribePrompt("scribe", "summarize this document");
    expect(prompt).toContain("summarize this document");
  });

  it("uses scribe name in identity", () => {
    const prompt = buildScribePrompt("scribe", "task");
    expect(prompt).toContain("scribe");
  });

  it("unknown name falls through to default with that name", () => {
    const prompt = buildScribePrompt("custom-bot", "do something");
    expect(prompt).toContain("custom-bot");
    expect(prompt).toContain("do something");
  });

  it("empty name falls back to 'scribe'", () => {
    const prompt = buildScribePrompt("", "task");
    expect(prompt).toContain("scribe");
  });
});

describe("buildScribePrompt — task truncation", () => {
  it("truncates task at 2400 chars", () => {
    const longTask = "x".repeat(3000);
    const prompt = buildScribePrompt("roamer", longTask);
    expect(prompt).toContain("x".repeat(2400));
    expect(prompt).not.toContain("x".repeat(2401));
  });

  it("short task is not padded", () => {
    const prompt = buildScribePrompt("scribe", "short task");
    expect(prompt).toContain("short task");
  });
});
