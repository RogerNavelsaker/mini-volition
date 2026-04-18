import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadFleetConfig,
  saveFleetConfig,
  addAgentToConfig,
  removeAgentFromConfig,
  generateKdlFromConfig,
  patchKdl,
  type AgentConfig,
} from "./kdl-patch";

const RUNTIME = "/runtime/test";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `kdl-patch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("loadFleetConfig", () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns defaults when config file does not exist", () => {
    const defaults: AgentConfig[] = [{ name: "claude", model: "m1", socket: "c.sock" }];
    const cfg = loadFleetConfig(join(dir, "missing.json"), defaults);
    expect(cfg.agents).toHaveLength(1);
    expect(cfg.agents[0].name).toBe("claude");
  });

  it("reads agents from existing config file", () => {
    const path = join(dir, "fleet.json");
    writeFileSync(path, JSON.stringify({ agents: [{ name: "gemini", model: "g1", socket: "g.sock" }] }));
    const cfg = loadFleetConfig(path);
    expect(cfg.agents[0].name).toBe("gemini");
  });

  it("returns defaults when config file is invalid JSON", () => {
    const path = join(dir, "fleet.json");
    writeFileSync(path, "not-json");
    const defaults: AgentConfig[] = [{ name: "claude", model: "m1", socket: "c.sock" }];
    const cfg = loadFleetConfig(path, defaults);
    expect(cfg.agents[0].name).toBe("claude");
  });

  it("returns defaults when config has no agents array", () => {
    const path = join(dir, "fleet.json");
    writeFileSync(path, JSON.stringify({ other: true }));
    const defaults: AgentConfig[] = [{ name: "claude", model: "m1", socket: "c.sock" }];
    const cfg = loadFleetConfig(path, defaults);
    expect(cfg.agents[0].name).toBe("claude");
  });

  it("returns empty agents when no file and no defaults", () => {
    const cfg = loadFleetConfig(join(dir, "missing.json"));
    expect(cfg.agents).toHaveLength(0);
  });
});

describe("saveFleetConfig", () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes valid JSON with agents array", () => {
    const path = join(dir, "fleet.json");
    saveFleetConfig(path, { agents: [{ name: "claude", model: "m1", socket: "c.sock" }] });
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.agents[0].name).toBe("claude");
  });

  it("round-trips through loadFleetConfig", () => {
    const path = join(dir, "fleet.json");
    const config = { agents: [{ name: "gemini", model: "g1", socket: "g.sock" }] };
    saveFleetConfig(path, config);
    const loaded = loadFleetConfig(path);
    expect(loaded.agents[0].name).toBe("gemini");
  });
});

describe("addAgentToConfig", () => {
  it("adds a new agent to empty config", () => {
    const result = addAgentToConfig({ agents: [] }, { name: "claude", model: "m1", socket: "c.sock" });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("claude");
  });

  it("appends new agent to existing agents", () => {
    const result = addAgentToConfig(
      { agents: [{ name: "claude", model: "m1", socket: "c.sock" }] },
      { name: "gemini", model: "g1", socket: "g.sock" },
    );
    expect(result.agents).toHaveLength(2);
  });

  it("replaces existing agent with same name", () => {
    const result = addAgentToConfig(
      { agents: [{ name: "claude", model: "m1", socket: "c.sock" }] },
      { name: "claude", model: "m2", socket: "c2.sock" },
    );
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].model).toBe("m2");
  });

  it("does not mutate original config", () => {
    const original = { agents: [{ name: "claude", model: "m1", socket: "c.sock" }] };
    addAgentToConfig(original, { name: "gemini", model: "g1", socket: "g.sock" });
    expect(original.agents).toHaveLength(1);
  });
});

describe("removeAgentFromConfig", () => {
  it("removes an existing agent by name", () => {
    const result = removeAgentFromConfig(
      { agents: [{ name: "claude", model: "m1", socket: "c.sock" }, { name: "gemini", model: "g1", socket: "g.sock" }] },
      "claude",
    );
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("gemini");
  });

  it("returns unchanged config when agent not found", () => {
    const result = removeAgentFromConfig(
      { agents: [{ name: "claude", model: "m1", socket: "c.sock" }] },
      "nonexistent",
    );
    expect(result.agents).toHaveLength(1);
  });

  it("returns empty agents when removing the only agent", () => {
    const result = removeAgentFromConfig(
      { agents: [{ name: "claude", model: "m1", socket: "c.sock" }] },
      "claude",
    );
    expect(result.agents).toHaveLength(0);
  });

  it("does not mutate original config", () => {
    const original = { agents: [{ name: "claude", model: "m1", socket: "c.sock" }] };
    removeAgentFromConfig(original, "claude");
    expect(original.agents).toHaveLength(1);
  });
});

describe("generateKdlFromConfig", () => {
  it("produces a layout block", () => {
    const kdl = generateKdlFromConfig({ agents: [] }, RUNTIME);
    expect(kdl).toContain("layout {");
  });

  it("includes agent pane with correct name", () => {
    const kdl = generateKdlFromConfig(
      { agents: [{ name: "claude", model: "m1", socket: "c.sock" }] },
      RUNTIME,
    );
    expect(kdl).toContain('pane name="CLAUDE"');
  });

  it("includes AGENT_NAME env var in agent pane args", () => {
    const kdl = generateKdlFromConfig(
      { agents: [{ name: "gemini", model: "g1", socket: "g.sock" }] },
      RUNTIME,
    );
    expect(kdl).toContain("AGENT_NAME=gemini");
  });

  it("includes INFERENCE_CLOUD_MODEL in agent pane args", () => {
    const kdl = generateKdlFromConfig(
      { agents: [{ name: "claude", model: "claude-sonnet-4", socket: "c.sock" }] },
      RUNTIME,
    );
    expect(kdl).toContain("claude-sonnet-4");
  });

  it("includes both agents when config has two", () => {
    const kdl = generateKdlFromConfig(
      {
        agents: [
          { name: "claude", model: "m1", socket: "c.sock" },
          { name: "gemini", model: "g1", socket: "g.sock" },
        ],
      },
      RUNTIME,
    );
    expect(kdl).toContain('pane name="CLAUDE"');
    expect(kdl).toContain('pane name="GEMINI"');
  });

  it("includes TOWN SQUARE, DIGEST, MEMORY, OPERATOR panes", () => {
    const kdl = generateKdlFromConfig({ agents: [] }, RUNTIME);
    expect(kdl).toContain("TOWN SQUARE");
    expect(kdl).toContain("DIGEST");
    expect(kdl).toContain("MEMORY");
    expect(kdl).toContain("OPERATOR");
  });

  it("includes providers tab", () => {
    const kdl = generateKdlFromConfig({ agents: [] }, RUNTIME);
    expect(kdl).toContain('tab name="providers"');
    expect(kdl).toContain("CLAUDE-API");
    expect(kdl).toContain("GEMINI-API");
  });

  it("includes inference tab", () => {
    const kdl = generateKdlFromConfig({ agents: [] }, RUNTIME);
    expect(kdl).toContain('tab name="inference"');
    expect(kdl).toContain("EMBED");
    expect(kdl).toContain("LIGHT");
    expect(kdl).toContain("HEAVY");
  });

  it("uses runtimeDir in socket paths", () => {
    const kdl = generateKdlFromConfig(
      { agents: [{ name: "claude", model: "m1", socket: "c.sock" }] },
      "/custom/runtime",
    );
    expect(kdl).toContain("/custom/runtime/");
  });
});

describe("patchKdl", () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes a kdl file", () => {
    const configPath = join(dir, "fleet.json");
    const layoutPath = join(dir, "fleet.kdl");
    writeFileSync(configPath, JSON.stringify({ agents: [{ name: "claude", model: "m1", socket: "c.sock" }] }));
    patchKdl(configPath, layoutPath, RUNTIME);
    expect(existsSync(layoutPath)).toBe(true);
  });

  it("writes kdl containing agent from config", () => {
    const configPath = join(dir, "fleet.json");
    const layoutPath = join(dir, "fleet.kdl");
    writeFileSync(configPath, JSON.stringify({ agents: [{ name: "testbot", model: "m1", socket: "t.sock" }] }));
    patchKdl(configPath, layoutPath, RUNTIME);
    const content = readFileSync(layoutPath, "utf-8");
    expect(content).toContain("TESTBOT");
  });

  it("uses defaults when config file is missing", () => {
    const layoutPath = join(dir, "fleet.kdl");
    const defaults: AgentConfig[] = [{ name: "fallback", model: "m1", socket: "f.sock" }];
    patchKdl(join(dir, "missing.json"), layoutPath, RUNTIME, defaults);
    const content = readFileSync(layoutPath, "utf-8");
    expect(content).toContain("FALLBACK");
  });

  it("overwrites existing kdl file", () => {
    const configPath = join(dir, "fleet.json");
    const layoutPath = join(dir, "fleet.kdl");
    writeFileSync(layoutPath, "old content");
    writeFileSync(configPath, JSON.stringify({ agents: [{ name: "claude", model: "m1", socket: "c.sock" }] }));
    patchKdl(configPath, layoutPath, RUNTIME);
    const content = readFileSync(layoutPath, "utf-8");
    expect(content).not.toBe("old content");
    expect(content).toContain("layout {");
  });
});
