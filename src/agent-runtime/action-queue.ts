export class HaltError extends Error {
  constructor(
    public readonly actionType: string,
    public readonly actionIndex: number,
  ) {
    super(`Unknown action type '${actionType}' at index ${actionIndex} — halting queue`);
    this.name = "HaltError";
  }
}

export interface ActionRecord {
  type: string;
  [key: string]: unknown;
}

export type JournalPhase = "planned" | "started" | "completed" | "failed" | "skipped";

export interface ActionQueueCallbacks {
  journal: (actionType: string, actionIndex: number, phase: JournalPhase, detail: string | null) => void;
  execute: (action: ActionRecord, actionIndex: number) => Promise<string | null>;
  isReplyAlreadySent?: (actionIndex: number) => boolean;
  escalate: (message: string) => void;
  log: (message: string) => void;
}

export interface ActionQueueResult {
  executed: number;
  skipped: number;
  halted: boolean;
  haltReason: string | null;
}

const KNOWN_ACTION_TYPES = new Set([
  "reply", "note", "noop", "sleep_until", "queue_task",
  "escalate", "scratchpad", "spawn_scribe",
]);

export async function executeActionQueue(
  actions: ActionRecord[],
  callbacks: ActionQueueCallbacks,
  completedIndexes: Set<number> = new Set(),
): Promise<ActionQueueResult> {
  let executed = 0;
  let skipped = 0;

  for (const [i, action] of actions.entries()) {
    const oneBasedIndex = i + 1;

    if (completedIndexes.has(oneBasedIndex)) {
      callbacks.journal(action.type, oneBasedIndex, "skipped", "already completed in prior attempt");
      callbacks.log(`[skip] action ${oneBasedIndex}/${actions.length} ${action.type} — already completed`);
      skipped++;
      continue;
    }

    if (!KNOWN_ACTION_TYPES.has(action.type)) {
      callbacks.journal(action.type, oneBasedIndex, "failed", `unrecognized action type '${action.type}'`);
      const haltMsg = `Unrecognized action type '${action.type}' at position ${oneBasedIndex} — halting queue`;
      callbacks.escalate(haltMsg);
      callbacks.log(`[halt] ${haltMsg}`);
      return { executed, skipped, halted: true, haltReason: haltMsg };
    }

    callbacks.journal(action.type, oneBasedIndex, "planned", null);
    callbacks.log(`[plan] action ${oneBasedIndex}/${actions.length} ${action.type}`);

    try {
      callbacks.journal(action.type, oneBasedIndex, "started", null);
      callbacks.log(`[start] action ${oneBasedIndex}/${actions.length} ${action.type}`);

      const detail = await callbacks.execute(action, oneBasedIndex);
      callbacks.journal(action.type, oneBasedIndex, "completed", detail);
      callbacks.log(`[done] action ${oneBasedIndex}/${actions.length} ${action.type}${detail ? ` — ${detail}` : ""}`);
      executed++;
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      callbacks.journal(action.type, oneBasedIndex, "failed", errorText);
      callbacks.log(`[fail] action ${oneBasedIndex}/${actions.length} ${action.type} — ${errorText}`);
      throw error;
    }
  }

  return { executed, skipped, halted: false, haltReason: null };
}

export function loadCompletedActionIndexes(
  runQuery: (query: string, ...args: unknown[]) => Array<{ action_index: number; phase: string }>,
  agentName: string,
  messageId: number,
): Set<number> {
  const rows = runQuery(
    `SELECT action_index, phase FROM fleet_agent_action_journal
     WHERE agent_name = ? AND message_id = ? AND phase = 'completed'`,
    agentName,
    messageId,
  );
  return new Set(rows.map((r) => r.action_index));
}
