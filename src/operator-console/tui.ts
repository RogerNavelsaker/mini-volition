import type { FleetMessage } from "../agent-mail/core";

export type OperatorAgentRow = {
  agent_name: string;
  status: string;
  health_status: string | null;
  current_task: string | null;
  wake_reason: string | null;
  cooldown_until: string | null;
  updated_at: string;
};

export type QueueTotals = {
  jobs: number;
  alarms: number;
  events: number;
};

export type AgentQueueRow = {
  agent_name: string;
  jobs: number;
  alarms: number;
  events: number;
};

export type OperatorSnapshot = {
  agents: OperatorAgentRow[];
  queueTotals: QueueTotals;
  queueByAgent: AgentQueueRow[];
  unreadCount: number;
  recentMail: FleetMessage[];
};

export type Tab = "overview" | "mail" | "compose";
export type ComposeField = "recipient" | "body";

export type OperatorTuiState = {
  activeTab: Tab;
  overviewIndex: number;
  mailIndex: number;
  composeField: ComposeField;
  composeRecipient: string;
  composeBody: string;
  flash: string | null;
  shouldQuit: boolean;
  refreshRequested: boolean;
};

export type TuiEffect =
  | { type: "none" }
  | { type: "send"; recipient: string; body: string }
  | { type: "refresh" }
  | { type: "quit" };

export type TuiAction =
  | { type: "key"; sequence: string; ctrl?: boolean; name?: string }
  | { type: "flash"; message: string | null };

const TABS: Tab[] = ["overview", "mail", "compose"];

const STATUS_COLORS: Record<string, number> = {
  idle: 32,
  thinking: 36,
  cooldown: 33,
  sleeping: 34,
  rate_limited: 35,
  error: 31,
};

const HEALTH_COLORS: Record<string, number> = {
  active: 32,
  latent: 33,
  dead: 31,
};

export function createInitialState(): OperatorTuiState {
  return {
    activeTab: "overview",
    overviewIndex: 0,
    mailIndex: 0,
    composeField: "recipient",
    composeRecipient: "",
    composeBody: "",
    flash: null,
    shouldQuit: false,
    refreshRequested: false,
  };
}

function clampIndex(index: number, size: number): number {
  if (size <= 0) return 0;
  return Math.max(0, Math.min(index, size - 1));
}

function nextTab(current: Tab, delta: 1 | -1): Tab {
  const idx = TABS.indexOf(current);
  return TABS[(idx + delta + TABS.length) % TABS.length]!;
}

function activeComposeValue(state: OperatorTuiState): string {
  return state.composeField === "recipient" ? state.composeRecipient : state.composeBody;
}

function setActiveComposeValue(state: OperatorTuiState, value: string): OperatorTuiState {
  return state.composeField === "recipient"
    ? { ...state, composeRecipient: value }
    : { ...state, composeBody: value };
}

function clearFlash(state: OperatorTuiState): OperatorTuiState {
  if (!state.flash && !state.refreshRequested) return state;
  return { ...state, flash: null, refreshRequested: false };
}

export function reduceTuiState(state: OperatorTuiState, action: TuiAction, snapshot: OperatorSnapshot): [OperatorTuiState, TuiEffect] {
  if (action.type === "flash") {
    return [{ ...state, flash: action.message }, { type: "none" }];
  }

  let next = clearFlash(state);
  const key = action.sequence;
  const lower = key.toLowerCase();

  if (action.ctrl && lower === "c") {
    return [{ ...next, shouldQuit: true }, { type: "quit" }];
  }

  if (action.name === "escape" || lower === "q") {
    return [{ ...next, shouldQuit: true }, { type: "quit" }];
  }

  if (action.name === "tab") {
    return [{ ...next, activeTab: nextTab(next.activeTab, 1) }, { type: "none" }];
  }

  if (action.name === "left") {
    return [{ ...next, activeTab: nextTab(next.activeTab, -1) }, { type: "none" }];
  }

  if (action.name === "right") {
    return [{ ...next, activeTab: nextTab(next.activeTab, 1) }, { type: "none" }];
  }

  if (lower === "1") return [{ ...next, activeTab: "overview" }, { type: "none" }];
  if (lower === "2") return [{ ...next, activeTab: "mail" }, { type: "none" }];
  if (lower === "3") return [{ ...next, activeTab: "compose" }, { type: "none" }];

  if (lower === "r") {
    return [{ ...next, refreshRequested: true }, { type: "refresh" }];
  }

  if (next.activeTab === "overview") {
    if (action.name === "down" || lower === "j") {
      return [{ ...next, overviewIndex: clampIndex(next.overviewIndex + 1, snapshot.agents.length) }, { type: "none" }];
    }
    if (action.name === "up" || lower === "k") {
      return [{ ...next, overviewIndex: clampIndex(next.overviewIndex - 1, snapshot.agents.length) }, { type: "none" }];
    }
    if (action.name === "return") {
      const selected = snapshot.agents[clampIndex(next.overviewIndex, snapshot.agents.length)];
      return selected
        ? [{
            ...next,
            activeTab: "compose",
            composeRecipient: selected.agent_name,
            composeField: "body",
            flash: `Targeting ${selected.agent_name}`,
          }, { type: "none" }]
        : [next, { type: "none" }];
    }
    return [next, { type: "none" }];
  }

  if (next.activeTab === "mail") {
    if (action.name === "down" || lower === "j") {
      return [{ ...next, mailIndex: clampIndex(next.mailIndex + 1, snapshot.recentMail.length) }, { type: "none" }];
    }
    if (action.name === "up" || lower === "k") {
      return [{ ...next, mailIndex: clampIndex(next.mailIndex - 1, snapshot.recentMail.length) }, { type: "none" }];
    }
    if (action.name === "return") {
      const selected = snapshot.recentMail[clampIndex(next.mailIndex, snapshot.recentMail.length)];
      return selected
        ? [{
            ...next,
            activeTab: "compose",
            composeRecipient: selected.sender,
            composeField: "body",
            flash: `Replying to ${selected.sender}`,
          }, { type: "none" }]
        : [next, { type: "none" }];
    }
    return [next, { type: "none" }];
  }

  if (action.name === "up" || action.name === "down") {
    return [{ ...next, composeField: next.composeField === "recipient" ? "body" : "recipient" }, { type: "none" }];
  }

  if (action.ctrl && lower === "u") {
    return [setActiveComposeValue(next, ""), { type: "none" }];
  }

  if (action.name === "backspace") {
    const current = activeComposeValue(next);
    return [setActiveComposeValue(next, current.slice(0, -1)), { type: "none" }];
  }

  if (action.name === "return") {
    const recipient = next.composeRecipient.trim().toLowerCase();
    const body = next.composeBody.trim();
    if (!recipient || !body) {
      return [{ ...next, flash: "Compose needs recipient and body" }, { type: "none" }];
    }
    return [
      {
        ...next,
        composeBody: "",
        composeField: "body",
        flash: `Sent to ${recipient}`,
      },
      { type: "send", recipient, body },
    ];
  }

  if (!action.ctrl && key.length === 1 && key >= " ") {
    return [setActiveComposeValue(next, activeComposeValue(next) + key), { type: "none" }];
  }

  return [next, { type: "none" }];
}

function ansi(code: number, value: string): string {
  return `\x1b[${code}m${value}\x1b[0m`;
}

function bold(value: string): string {
  return ansi(1, value);
}

function dim(value: string): string {
  return ansi(2, value);
}

function color(code: number, value: string): string {
  return ansi(code, value);
}

function pad(value: string, width: number): string {
  const raw = value.length >= width ? value.slice(0, Math.max(0, width - 1)) + "…" : value;
  return raw.padEnd(width, " ");
}

function summarizeTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString([], { month: "2-digit", day: "2-digit" })} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function statusBadge(status: string): string {
  return color(STATUS_COLORS[status] ?? 37, status);
}

function healthBadge(status: string | null): string {
  if (!status) return dim("unknown");
  return color(HEALTH_COLORS[status] ?? 37, status);
}

function lineClamp(value: string, width: number): string {
  if (width <= 1) return "";
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

function renderTabs(active: Tab): string {
  return TABS.map((tab, index) => {
    const label = `${index + 1}:${tab}`;
    return tab === active ? bold(`[${label}]`) : dim(` ${label} `);
  }).join(" ");
}

function renderOverview(state: OperatorTuiState, snapshot: OperatorSnapshot, width: number, height: number): string[] {
  const lines: string[] = [];
  const totals = snapshot.queueTotals;
  lines.push(
    `${bold("Fleet")}  agents=${snapshot.agents.length}  unread=${snapshot.unreadCount}  jobs=${totals.jobs}  alarms=${totals.alarms}  events=${totals.events}`,
  );
  lines.push("");
  lines.push(
    `${dim(pad("agent", 14))} ${dim(pad("status", 14))} ${dim(pad("health", 10))} ${dim(pad("task", 24))} ${dim("cooldown")}`,
  );

  const available = Math.max(0, height - 8);
  const start = Math.max(0, Math.min(state.overviewIndex - Math.floor(available / 2), Math.max(0, snapshot.agents.length - available)));
  const visible = snapshot.agents.slice(start, start + available);
  for (let index = 0; index < visible.length; index += 1) {
    const row = visible[index]!;
    const absolute = start + index;
    const selected = absolute === clampIndex(state.overviewIndex, snapshot.agents.length);
    const queue = snapshot.queueByAgent.find((entry) => entry.agent_name === row.agent_name);
    const task = row.current_task || row.wake_reason || "—";
    const queueInfo = queue ? ` j:${queue.jobs} a:${queue.alarms} e:${queue.events}` : "";
    const line =
      `${pad(row.agent_name, 14)} ${pad(row.status, 14)} ${pad(row.health_status || "unknown", 10)} ${pad(task, 24)} ${summarizeTime(row.cooldown_until)}${queueInfo}`;
    lines.push(selected ? color(7, lineClamp(line, width)) : lineClamp(line, width));
  }
  lines.push("");
  const selected = snapshot.agents[clampIndex(state.overviewIndex, snapshot.agents.length)];
  if (selected) {
    lines.push(bold(`Selected ${selected.agent_name}`));
    lines.push(lineClamp(`status ${statusBadge(selected.status)}  health ${healthBadge(selected.health_status)}`, width));
    lines.push(lineClamp(`task ${selected.current_task || "—"}`, width));
    lines.push(lineClamp(`wake ${selected.wake_reason || "—"}`, width));
    lines.push(lineClamp(`updated ${summarizeTime(selected.updated_at)}  cooldown ${summarizeTime(selected.cooldown_until)}`, width));
  }
  return lines;
}

function renderMail(state: OperatorTuiState, snapshot: OperatorSnapshot, width: number, height: number): string[] {
  const lines: string[] = [];
  lines.push(`${bold("Mail")}  unread=${snapshot.unreadCount}`);
  lines.push("");
  const available = Math.max(0, height - 8);
  const start = Math.max(0, Math.min(state.mailIndex - Math.floor(available / 2), Math.max(0, snapshot.recentMail.length - available)));
  const visible = snapshot.recentMail.slice(start, start + available);
  for (let index = 0; index < visible.length; index += 1) {
    const row = visible[index]!;
    const absolute = start + index;
    const selected = absolute === clampIndex(state.mailIndex, snapshot.recentMail.length);
    const route = `${row.sender} -> ${row.recipient}`;
    const line = `${summarizeTime(row.created_at)} ${pad(route, 26)} ${row.body}`;
    lines.push(selected ? color(7, lineClamp(line, width)) : lineClamp(line, width));
  }
  lines.push("");
  const selected = snapshot.recentMail[clampIndex(state.mailIndex, snapshot.recentMail.length)];
  if (selected) {
    lines.push(bold("Selected message"));
    lines.push(lineClamp(`from ${selected.sender}  to ${selected.recipient}  layer ${selected.layer}`, width));
    lines.push(lineClamp(selected.body, width));
  }
  return lines;
}

function renderCompose(state: OperatorTuiState, width: number): string[] {
  const lines: string[] = [];
  const recipient = state.composeField === "recipient" ? color(7, state.composeRecipient || " ") : state.composeRecipient || " ";
  const body = state.composeField === "body" ? color(7, state.composeBody || " ") : state.composeBody || " ";
  lines.push(bold("Compose"));
  lines.push("");
  lines.push(lineClamp(`recipient: ${recipient}`, width));
  lines.push(lineClamp(`message:   ${body}`, width));
  lines.push("");
  lines.push(dim("Enter sends. Up/Down switches field. Tab switches mode. q quits."));
  return lines;
}

export function renderScreen(state: OperatorTuiState, snapshot: OperatorSnapshot, width: number, height: number): string {
  const safeWidth = Math.max(40, width || 80);
  const safeHeight = Math.max(16, height || 24);
  const lines: string[] = [];
  lines.push(bold("operator-console"));
  lines.push(renderTabs(state.activeTab));
  lines.push("─".repeat(safeWidth));

  const bodyHeight = safeHeight - 5;
  const body =
    state.activeTab === "overview"
      ? renderOverview(state, snapshot, safeWidth, bodyHeight)
      : state.activeTab === "mail"
        ? renderMail(state, snapshot, safeWidth, bodyHeight)
        : renderCompose(state, safeWidth);

  lines.push(...body.slice(0, Math.max(0, safeHeight - 5)));
  while (lines.length < safeHeight - 1) lines.push("");
  lines.push(state.flash ? lineClamp(state.flash, safeWidth) : dim("j/k move • enter drills into compose • r refresh"));
  return lines.map((line) => lineClamp(line, safeWidth)).join("\n");
}
