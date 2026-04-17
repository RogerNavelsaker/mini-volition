import { describe, expect, test } from "bun:test";

function formatGhostOrientation(ghost: {
  turn_key: string;
  failure_kind: string;
  wake_source: string;
  wake_reason: string;
  message_id: number | null;
  checkpoint_status: string | null;
  detail: string | null;
  last_action?: { action_type: string; phase: string; detail: string | null } | null;
}) {
  const lines = [
    `§ORIENTATION ! ALERT: AgentGhosted`,
    `- previous_turn=${ghost.turn_key}`,
    `- failure_kind=${ghost.failure_kind}`,
    `- wake_source=${ghost.wake_source}`,
    `- wake_reason=${ghost.wake_reason}`,
  ];
  if (ghost.message_id != null) lines.push(`- message_id=${ghost.message_id}`);
  if (ghost.checkpoint_status) lines.push(`- checkpoint_status=${ghost.checkpoint_status}`);
  if (ghost.last_action) {
    lines.push(`- last_action=${ghost.last_action.action_type} phase=${ghost.last_action.phase}${ghost.last_action.detail ? ` detail=${ghost.last_action.detail}` : ""}`);
  } else {
    lines.push(`- last_action=(none recorded before failure)`);
  }
  if (ghost.detail) lines.push(`- detail=${ghost.detail}`);
  lines.push(`Acknowledge this failure in your first reasoning block, then continue the turn.`);
  return lines.join("\n");
}

describe("ghost orientation formatting", () => {
  test("includes prior failure and action-journal context", () => {
    const text = formatGhostOrientation({
      turn_key: "mail_burst:42:123",
      failure_kind: "deadman",
      wake_source: "mail_burst",
      wake_reason: "mail:private:42",
      message_id: 42,
      checkpoint_status: "prompt_built",
      detail: "turn timed out after 30000ms",
      last_action: { action_type: "reply", phase: "started", detail: "drafting response" },
    });

    expect(text).toContain("§ORIENTATION ! ALERT: AgentGhosted");
    expect(text).toContain("failure_kind=deadman");
    expect(text).toContain("last_action=reply phase=started detail=drafting response");
    expect(text).toContain("turn timed out after 30000ms");
  });
});
