import { appendFileSync, mkdirSync } from "fs";
import { dirname, join, resolve } from "path";

function stateRoot(): string {
  return resolve(process.cwd(), process.env.FLEET_STATE_DIR || join(process.env.META_REPO_ROOT || ".", "state"));
}

function ensureParent(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

function appendLine(path: string, line: string) {
  ensureParent(path);
  appendFileSync(path, `${line}\n`, "utf-8");
}

export function appendTurnArtifact(agentName: string, record: Record<string, unknown>) {
  appendLine(join(stateRoot(), "turns", `${agentName}.jsonl`), JSON.stringify({
    recorded_at: new Date().toISOString(),
    ...record,
  }));
}

export function appendActionArtifact(agentName: string, record: Record<string, unknown>) {
  appendLine(join(stateRoot(), "actions", `${agentName}.jsonl`), JSON.stringify({
    recorded_at: new Date().toISOString(),
    ...record,
  }));
}

export function appendReviewArtifact(agentName: string, heading: string, body: string) {
  appendLine(
    join(stateRoot(), "reviews", `${agentName}.md`),
    `## ${new Date().toISOString()} ${heading}\n${body}\n`,
  );
}

export function appendRuntimeArtifact(agentName: string, record: Record<string, unknown>) {
  appendLine(join(stateRoot(), "runtime", `${agentName}.jsonl`), JSON.stringify({
    recorded_at: new Date().toISOString(),
    ...record,
  }));
}

export function appendJobArtifact(agentName: string, record: Record<string, unknown>) {
  appendLine(join(stateRoot(), "jobs", `${agentName}.jsonl`), JSON.stringify({
    recorded_at: new Date().toISOString(),
    ...record,
  }));
}

export function appendMailArtifact(agentName: string, record: Record<string, unknown>) {
  appendLine(join(stateRoot(), "mail", `${agentName}.jsonl`), JSON.stringify({
    recorded_at: new Date().toISOString(),
    ...record,
  }));
}

export function appendFleetArtifact(topic: string, record: Record<string, unknown>) {
  appendLine(join(stateRoot(), "fleet", `${topic}.jsonl`), JSON.stringify({
    recorded_at: new Date().toISOString(),
    ...record,
  }));
}

export function appendMemoryArtifact(agentName: string, record: Record<string, unknown>) {
  appendLine(join(stateRoot(), "memory", `${agentName}.jsonl`), JSON.stringify({
    recorded_at: new Date().toISOString(),
    ...record,
  }));
}

export function appendMemorySourceArtifact(kind: "working" | "episodic" | "archival" | "digests", key: string, record: Record<string, unknown>) {
  appendLine(join(stateRoot(), "memory-source", kind, `${key}.jsonl`), JSON.stringify({
    recorded_at: new Date().toISOString(),
    ...record,
  }));
}
