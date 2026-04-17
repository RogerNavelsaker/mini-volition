import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

describe("Agent State Consensus", () => {
  const tempDir = join(process.cwd(), ".tmp-consensus-test");
  const dbPath = join(tempDir, "runtime/agent-state.db");
  const runtimeDir = join(tempDir, "state", "runtime");

  const resetTempDir = () => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(join(tempDir, "runtime"), { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
  };

  beforeAll(() => {
    resetTempDir();
  });

  afterAll(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test("proposal-create and vote-cast persist consensus records", () => {
    resetTempDir();
    const proposal = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts proposal-create claude adopt-safety-rail \"Require consensus before enabling auto-merge\" unanimity open`,
      ).toString("utf-8"),
    ) as { id: number; proposer_agent: string; strategy: string; status: string };

    expect(proposal.proposer_agent).toBe("claude");
    expect(proposal.strategy).toBe("unanimity");
    expect(proposal.status).toBe("open");

    const vote = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts vote-cast ${proposal.id} codex approve \"safe default\"`,
      ).toString("utf-8"),
    ) as { proposal_id: number; voter_agent: string; vote: string };

    expect(vote.proposal_id).toBe(proposal.id);
    expect(vote.voter_agent).toBe("codex");
    expect(vote.vote).toBe("approve");

    const storedProposal = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts proposal-get ${proposal.id}`,
      ).toString("utf-8"),
    ) as { topic: string };

    expect(storedProposal.topic).toBe("adopt-safety-rail");

    const votes = JSON.parse(
      execSync(
        `AGENT_STATE_DB=${dbPath} META_REPO_ROOT=${tempDir} bun run src/agent-state/main.ts vote-list ${proposal.id}`,
      ).toString("utf-8"),
    ) as Array<{ voter_agent: string }>;

    expect(votes).toHaveLength(1);
    expect(votes[0]?.voter_agent).toBe("codex");
  });
});
