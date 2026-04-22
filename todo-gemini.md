Based on an analysis of both codebases, `mini-volition` is deliberately **far** from having the high-agency capabilities of the upstream `volition` repository—but this is an intentional architectural choice rather than just missing features.

Here is the breakdown of capabilities and why the gap exists:

### 1. The Tool Gap
In the upstream `volition` (specifically inside `guppi.py`), agents have direct access to ~21 highly capable tools, including:
* **System Agency:** `shell`, `remote_exec`, `spawn_abe` (cloning)
* **Internet:** `web_search`, `web_read`
* **Agent Spawning:** `spawn_roamer` (multi-turn investigator), `spawn_scribe`
* **Memory & Chat:** `rag_search`, `chat_history`, `chat_grab_stick`, `subscribe_channel`
* **Task Management:** `todo_list`, `todo_add`, `todo_complete`, `snooze_task`

In contrast, `mini-volition` (found in `src/agent-runtime/action-queue.ts`) severely restricts the agent runtime to just **8 primitive actions**:
* `reply`, `note`, `noop`, `sleep_until`, `queue_task`, `escalate`, `scratchpad`, `spawn_scribe`

### 2. What `mini-volition` is Missing (and Why)
`mini-volition` lacks the following capabilities entirely within its runtime:
* **No Direct OS Execution:** It lacks `shell` and `remote_exec`. In `mini-volition`'s philosophy, the runtime fleet does not touch the host OS directly. Instead, "Dev Agents" (like myself, Gemini CLI, Claude Code) handle shell execution, while the fleet handles message passing.
* **No Web Browsing:** It lacks `web_search` and `web_read` (which upstream handled via SearXNG and Trafilatura).
* **No Roamers:** It lacks `spawn_roamer`.
* **No Active RAG Retrieval:** It lacks `rag_search`. Upstream used ChromaDB directly in the agent loop. `mini-volition` relies on background workers (like `fleet-librarian` and `inference-local-embed`) to manage memory, likely passing context *into* the agent upon wake rather than letting the agent query it dynamically.
* **No Complex Chat State:** It drops synchronous chat locks (`chat_grab_stick`) and dynamic subscriptions (`subscribe_channel`) in favor of a simpler, polling-based SQLite transport layer (`agent-mail`).

### 3. Philosophical Difference
The upstream `volition` repo treats the LLM agent as a "god process" running in a massive monolith (`guppi.py`) that reaches out to the internet, SSHes into servers, and queries vector databases directly.

`mini-volition` strips all of this away to focus on **safety, durability, and separation of concerns**. It moves side-effects out of the runtime. The runtime fleet's only job is to think, take notes (`scratchpad`), delegate heavy lifting (`spawn_scribe`), and communicate (`reply`, `queue_task`, `escalate`). If code needs to be executed, that is a dev-time concern handled by CLI agents, not the background fleet runtime.

**Conclusion:**
`mini-volition` is not trying to achieve feature parity with `volition`. It is a complete philosophical rewrite that intentionally removes "dangerous" capabilities (like shell/web access) from the background daemon, narrowing the runtime to a highly durable, SQLite-backed message passing and reasoning engine.