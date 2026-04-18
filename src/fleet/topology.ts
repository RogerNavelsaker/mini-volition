import type { Database } from "bun:sqlite";

export type AgentTopologyState = {
  agent_name: string;
  status: string;
  health_status: string;
  updated_at: string;
  ghost_present: boolean;
  stuck: boolean;
  last_message_id: number | null;
};

export type RepairKind = "reassign_jobs" | "release_mail" | "clear_ghost" | "mark_dead";

export type RepairAction = {
  kind: RepairKind;
  agent_name: string;
  message_id: number | null;
  reason: string;
};

export type TopologyReport = {
  agents: AgentTopologyState[];
  healthy: string[];
  degraded: string[];
  dead: string[];
  repair_actions: RepairAction[];
};

type AgentRow = {
  agent_name: string;
  status: string;
  health_status: string;
  updated_at: string;
  last_message_id: number | null;
};

type GhostRow = {
  agent_name: string;
  message_id: number | null;
  wake_source: string;
};

function parseDateMs(value: string | null | undefined): number {
  if (!value) return 0;
  const iso = value.includes("T") ? value : value.replace(" ", "T");
  const normalized = iso.endsWith("Z") ? iso : `${iso}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

export function assessTopology(
  db: Database,
  stuckThresholdMs: number,
  nowIso: string = new Date().toISOString(),
): TopologyReport {
  const nowMs = Date.parse(nowIso);

  const agentRows = db.prepare(
    `SELECT agent_name, status, health_status, updated_at, last_message_id
     FROM fleet_agent_state
     ORDER BY agent_name ASC`,
  ).all() as AgentRow[];

  const ghostRows = db.prepare(
    `SELECT agent_name, message_id, wake_source
     FROM fleet_agent_ghosts`,
  ).all() as GhostRow[];

  const ghostByAgent = new Map<string, GhostRow>();
  for (const g of ghostRows) ghostByAgent.set(g.agent_name, g);

  const agents: AgentTopologyState[] = agentRows.map((row) => {
    const updatedMs = parseDateMs(row.updated_at);
    const stuck = row.status === "thinking" && (nowMs - updatedMs) > stuckThresholdMs;
    return {
      agent_name: row.agent_name,
      status: row.status,
      health_status: row.health_status,
      updated_at: row.updated_at,
      ghost_present: ghostByAgent.has(row.agent_name),
      stuck,
      last_message_id: row.last_message_id,
    };
  });

  const healthy: string[] = [];
  const degraded: string[] = [];
  const dead: string[] = [];
  const repair_actions: RepairAction[] = [];

  for (const agent of agents) {
    const ghost = ghostByAgent.get(agent.agent_name);

    if (agent.ghost_present && ghost) {
      degraded.push(agent.agent_name);
      repair_actions.push({
        kind: ghost.wake_source === "mail_burst" ? "release_mail" : "reassign_jobs",
        agent_name: agent.agent_name,
        message_id: ghost.message_id,
        reason: `agent ghosted during ${ghost.wake_source}`,
      });
      repair_actions.push({
        kind: "clear_ghost",
        agent_name: agent.agent_name,
        message_id: null,
        reason: "ghost cleared after work reassigned",
      });
    } else if (agent.stuck) {
      degraded.push(agent.agent_name);
      repair_actions.push({
        kind: agent.last_message_id !== null ? "reassign_jobs" : "mark_dead",
        agent_name: agent.agent_name,
        message_id: agent.last_message_id,
        reason: `agent stuck in thinking for >${stuckThresholdMs}ms`,
      });
    } else if (agent.health_status === "dead") {
      dead.push(agent.agent_name);
    } else if (agent.health_status === "latent") {
      degraded.push(agent.agent_name);
    } else {
      healthy.push(agent.agent_name);
    }
  }

  return { agents, healthy, degraded, dead, repair_actions };
}

export function listStuckAgents(
  db: Database,
  stuckThresholdMs: number,
  nowIso: string = new Date().toISOString(),
): AgentTopologyState[] {
  const report = assessTopology(db, stuckThresholdMs, nowIso);
  return report.agents.filter((a) => a.stuck);
}

export function listGhostedAgents(db: Database): string[] {
  const rows = db.prepare(
    `SELECT agent_name FROM fleet_agent_ghosts ORDER BY agent_name ASC`,
  ).all() as Array<{ agent_name: string }>;
  return rows.map((r) => r.agent_name);
}
