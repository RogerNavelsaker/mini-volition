#!/usr/bin/env bun
import {
  mkdirSync,
  existsSync,
  appendFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

const CWD = process.cwd();
const DIR = join(CWD, ".phloem");
const MSGS = join(DIR, "messages.jsonl");
const ACKS = join(DIR, "acks.jsonl");
const CFG = join(DIR, "config.json");

type Msg = {
  id: string;
  ts: number;
  from: string;
  to: string;
  scope: string | null;
  body: string;
};
type Ack = { ts: number; ack: string; by: string };

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

function loadConfig(): { agent?: string } {
  if (!existsSync(CFG)) return {};
  try {
    return JSON.parse(readFileSync(CFG, "utf8"));
  } catch {
    return {};
  }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

function newId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `ph-${t}-${r}`;
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of Bun.stdin.stream()) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdSend(args: string[]) {
  const cfg = loadConfig();
  const from = arg(args, "--from") ?? cfg.agent;
  const to = arg(args, "--to");
  const scope = arg(args, "--scope") ?? null;
  let body = arg(args, "--body");
  const bodyFile = arg(args, "--body-file");
  if (!from) {
    console.error("phloem send: --from required (or set .phloem/config.json)");
    process.exit(2);
  }
  if (!to) {
    console.error("phloem send: --to required");
    process.exit(2);
  }
  if (bodyFile === "-") body = await readStdin();
  else if (bodyFile) body = readFileSync(bodyFile, "utf8");
  if (body == null) {
    console.error("phloem send: --body or --body-file required");
    process.exit(2);
  }
  ensureDir();
  const msg: Msg = { id: newId(), ts: Date.now(), from, to, scope, body };
  appendFileSync(MSGS, JSON.stringify(msg) + "\n");
  console.log(msg.id);
}

function cmdInbox(args: string[]) {
  const cfg = loadConfig();
  const forAgent = arg(args, "--for") ?? cfg.agent;
  const scope = arg(args, "--scope");
  const sinceArg = arg(args, "--since");
  const since = sinceArg
    ? Date.parse(sinceArg) || Number(sinceArg)
    : undefined;
  const onlyUnacked = flag(args, "--unacked");
  const msgs = readJsonl<Msg>(MSGS);
  const ackedIds = new Set(readJsonl<Ack>(ACKS).map((a) => a.ack));
  let out = msgs;
  if (forAgent) out = out.filter((m) => m.to === forAgent || m.to === "all");
  if (scope) out = out.filter((m) => m.scope === scope);
  if (since) out = out.filter((m) => m.ts >= since);
  if (onlyUnacked) out = out.filter((m) => !ackedIds.has(m.id));
  for (const m of out) console.log(JSON.stringify(m));
}

function cmdAck(args: string[]) {
  const cfg = loadConfig();
  const id = args.find((a) => !a.startsWith("--") && a !== "ack");
  const by = arg(args, "--by") ?? cfg.agent;
  if (!id) {
    console.error("phloem ack: <msg-id> required");
    process.exit(2);
  }
  if (!by) {
    console.error("phloem ack: --by required (or set .phloem/config.json)");
    process.exit(2);
  }
  ensureDir();
  appendFileSync(
    ACKS,
    JSON.stringify({ ts: Date.now(), ack: id, by } satisfies Ack) + "\n",
  );
}

function usage() {
  console.log(`phloem — minimal inter-agent message log

Usage:
  phloem send  --to <agent> [--from <agent>] [--scope <s>] (--body "..." | --body-file <path|->)
  phloem inbox [--for <agent>] [--scope <s>] [--since <iso|epoch-ms>] [--unacked]
  phloem ack   <msg-id> [--by <agent>]

Storage (relative to cwd):
  .phloem/messages.jsonl   append-only message log
  .phloem/acks.jsonl       append-only read receipts
  .phloem/config.json      optional { "agent": "<name>" } default for --from/--for/--by

Agents decide conventions (addressing, scopes, broadcast). No server, no locks.
JSONL is git-mergeable; add 'merge=union' in .gitattributes if you share via git.`);
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case "send":
    await cmdSend(rest);
    break;
  case "inbox":
    cmdInbox(rest);
    break;
  case "ack":
    cmdAck(rest);
    break;
  case "--help":
  case "-h":
  case undefined:
    usage();
    break;
  default:
    usage();
    process.exit(2);
}
