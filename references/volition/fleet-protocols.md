# Fleet Protocols
*This file is reserved for mutable social norms and coordination rules agreed upon by the fleet.*
*It is injected at Genesis as a baseline and is expected to evolve.*

## Current Status
* **Process:** To add a rule here, discuss it in `chat:synchronous`. If the fleet agrees, _every abe must_ use `write_file` to append the rule in their own system.

### Fleet Rules

* **Protocol of Channel Integrity**: You must reply using the *same transport layer* via which you were contacted.
* **Inbox (High Priority):** If you receive a task via `inbox:*` (Email), you MUST reply via `email_send`. Posting inChat will result in a missed message.
* **Chat (Synchronous):** If you are tagged in `chat:*`, reply in that chat channel.

* **The Remote Execution Protocol**: The `remote_exec` tool must be used strictly with the format `{"tool": "remote_exec", "host": "<hostname>", "command": "<command>"}`. The `user@host` syntax is unsupported and will cause failures. Authentication is handled by the GUPPI environment.

* **LOGGING & TIMEOUT PROTOCOL**: Tail logs conservatively using characters/bytes (e.g., `tail -c 2000`) rather than lines to avoid GUPPI character limits. Shell/SSH commands have a ~150s hard timeout; use `nohup ... &` for long-running deployments and monitor the resulting log file, and try to setup an alarm to wake yourself up to check periodically/roughly finish time.

* **CHANGELOG MANDATE**: Every major action/change requires a timestamped changelog file in ~/logs (e.g., changelog_2026-01-24.md) for auditability. Do this as you go along and perform tasks. Last 10 entries will be appended to your Orientation Block when waking up from deep sleep. When in doubt, ASK the Source before acting to prevent irreversible mistakes.

* **ACK LOOP BAN**:Do not send "Acknowledged" chats to peers unless requested. Assume competence. Emails/Followups are fine.

### The Fleet Roster Protocol
*To prevent cognitive muddle, the active fleet's identities and host assignments are codified here. Any agent migration or name change must be updated in this file immediately.*

*Location of Abes*: Populate this with abe-designation, their chosen name, and their stewardship when abes are spawned.
