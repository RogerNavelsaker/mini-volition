import { join } from "path";
import { Database } from "bun:sqlite";
import { createInterface } from "readline";
import { spawnSync } from "child_process";
import { ensureMailSchema } from "../agent-mail/core";

const SKILL = `---
name: operator-console
description: Interactive CLI for the human operator to send and receive fleet messages
binary: operator-console
source: src/operator-console/main.ts
---

# Operator CLI

Binary: \`operator-console\`
Source: \`src/operator-console/main.ts\`

Interactive REPL for the human operator. Compiled with Bun, uses \`runtime/agent-mail.db\` with agent-mail.

## Usage

\`\`\`
operator-console skill  # print this skill document
operator-console        # start the REPL
\`\`\`

Type \`<recipient>: <message>\` for direct messages, or \`all: <message>\` for Town Square broadcasts.

### Slash Commands

- \`/status\` — show fleet runtime status
- \`/detach\` — detach the Zellij session
- \`/stop\`   — kill the Zellij session
- \`/down\`   — stop and wipe databases/sockets
- \`/help\`   — show help

## Sends on

- \`private\` layer — direct 1:1 coordination to a specific agent
- \`public\` layer — shared broadcasts visible in Town Square when recipient is \`all\`
`;

if (Bun.argv[2] === "skill") {
  console.log(SKILL);
  process.exit(0);
}

const dbPath = process.env.AGENT_MAIL_DB || join(process.env.META_REPO_ROOT || ".", "runtime/agent-mail.db");
const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
ensureMailSchema(db);

const sender = "operator";

type FleetMessage = {
  id: number;
  layer: string;
  recipient: string;
  sender: string;
  body: string;
  created_at: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isBusyError = (error: unknown) =>
  error instanceof Error &&
  ("code" in error || "message" in error) &&
  ((error as { code?: string }).code === "SQLITE_BUSY" ||
    error.message.includes("database is locked"));

const withBusyRetry = async <T>(fn: () => T, retries = 50): Promise<T> => {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isBusyError(error) || attempt === retries - 1) throw error;
      await sleep(100);
    }
  }
  throw new Error("unreachable");
};

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function formatTime(ts: string): string {
  const d = new Date(ts.endsWith("Z") ? ts : ts + "Z");
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatIncoming(msg: FleetMessage): string {
  const target = msg.recipient.toLowerCase() === "all" ? "" : ` ${dim("→")} ${cyan(msg.recipient)}`;
  return `${dim(formatTime(msg.created_at))} ${cyan(msg.sender)}${target}: ${msg.body}`;
}

function send(recipient: string, layer: string, body: string) {
  return withBusyRetry(() =>
    db.run(
      "INSERT INTO fleet_comms (recipient, layer, sender, body) VALUES (?, ?, ?, ?)",
      [recipient, layer, sender, body],
    ),
  );
}

function runFleet(cmd: string) {
  console.log(dim(`Executing: fleet ${cmd}...`));
  const res = spawnSync("fleet", [cmd], { stdio: "inherit" });
  if (res.status !== 0) {
    // If 'fleet' is not in path, try relative bin
    const relRes = spawnSync("./bin/fleet", [cmd], { stdio: "inherit" });
    if (relRes.status !== 0 && relRes.error) {
       console.log(yellow(`Fleet command failed. Ensure 'fleet' is in your PATH.`));
    }
  }
}

// poll for messages addressed to operator
let lastSeenId =
  ((await withBusyRetry(() =>
    db
      .prepare("SELECT MAX(id) AS id FROM fleet_comms WHERE recipient = ? OR recipient = 'all'")
      .get(sender),
  )) as { id: number | null } | undefined)?.id ?? 0;

async function pollIncoming(rl: ReturnType<typeof createInterface>) {
  while (true) {
    const rows = (await withBusyRetry(() =>
      db
        .prepare(
          "SELECT * FROM fleet_comms WHERE (recipient = ? OR recipient = 'all') AND sender != ? AND id > ? ORDER BY id ASC",
        )
        .all(sender, sender, lastSeenId),
    )) as FleetMessage[];

    for (const row of rows) {
      // clear current line, print message, redraw prompt
      process.stdout.write(`\r\x1b[K${formatIncoming(row)}\n`);
      rl.prompt(true);
      lastSeenId = row.id;
    }

    await sleep(1000);
  }
}

// REPL
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${bold(">")} `,
});

console.log(dim("Fleet operator CLI."));
console.log(dim("Commands: <agent>: <message> | /status | /detach | /stop | /down | /help"));
rl.prompt();

rl.on("line", async (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }

  // Handle slash commands
  if (trimmed.startsWith("/")) {
    const [cmd] = trimmed.slice(1).split(" ");
    switch (cmd.toLowerCase()) {
      case "status":
        runFleet("status");
        break;
      case "detach":
        runFleet("detach");
        break;
      case "stop":
        runFleet("stop");
        break;
      case "down":
        runFleet("down");
        break;
      case "help":
        console.log(dim("Available commands: /status, /detach, /stop, /down, /help"));
        console.log(dim("Messaging: <agent>: <message>  (e.g., claude: hello)"));
        break;
      default:
        console.log(yellow(`Unknown command: /${cmd}. Type /help for assistance.`));
    }
    rl.prompt();
    return;
  }

  const match = trimmed.match(/^(\w+):\s*(.+)$/s);
  if (!match) {
    console.log(dim("Format: <recipient>: <message>  or  /<command>"));
    rl.prompt();
    return;
  }

  const [, recipient, body] = match;
  const normalizedRecipient = recipient.toLowerCase();
  const layer = normalizedRecipient === "all" ? "public" : "private";
  await send(normalizedRecipient, layer, body);
  const target = recipient.toLowerCase() === "all" ? "" : ` ${dim("→")} ${cyan(recipient)}`;
  console.log(`${dim(formatTime(new Date().toISOString()))} ${green("you")}${target}: ${body}`);
  rl.prompt();
});

rl.on("close", () => {
  process.exit(0);
});

pollIncoming(rl);
