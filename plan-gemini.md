# Stewardship & Tool Gap Bridge Plan

This document outlines the architectural roadmap for `mini-volition` to reach feature parity with the upstream `volition` repository by introducing **Stewardship-Based Tooling** (Role-Based Access Control for LLM Agents).

## 1. The Core Tension: Agency vs. Security
The upstream `volition` repository (specifically within the monolithic `guppi.py`) granted all agents access to a wide array of high-agency tools (~21 tools, including `shell`, `remote_exec`, and `write_file`). While powerful, this created a significant security risk: any agent, regardless of its purpose, possessed the "keys to the kingdom."

`mini-volition` initially responded by restricting the agent runtime to 8 primitive actions (`reply`, `note`, `noop`, `sleep_until`, `queue_task`, `escalate`, `scratchpad`, `spawn_scribe`), prioritizing strict safety, durability, and isolation over raw agency.

## 2. The Solution: Agent Stewardship
To bridge this tool gap without compromising the robust foundation of `mini-volition`, the architecture will evolve to support **Agent Stewardship**. Instead of a uniform toolset, tools will be dynamically exposed based on an agent's configured role.

### Advantages of this Approach:
1. **Blast Radius Containment:** A "Personal Assistant" agent physically cannot execute arbitrary shell commands or wipe a repository because those tools are never injected into its context window.
2. **Context Window Optimization:** By only providing the JSON schema for tools relevant to an agent's role, we save valuable tokens, keeping inference fast and cost-effective.
3. **Specialized System Prompts:** Prompts (`genesis.md`, `coder.md`, etc.) can be tightly coupled to the agent's specific toolset and responsibilities.

## 3. Implementation Roadmap for `mini-volition`

Currently, `mini-volition` hardcodes allowed actions in `src/agent-runtime/action-queue.ts` via a static set (`KNOWN_ACTION_TYPES`). Transitioning to Stewardship requires refactoring this into a **Dynamic Tool Registry**.

### Step 1: Roster Configuration
Define agent roles within the fleet configuration (`fleet.toml` or `config.db`).

```toml
[agents.alice]
model = "inference-local-small"
role = "personal_assistant"

[agents.bob]
model = "inference-cloud-anthropic"
role = "codebase_steward"
```


### Step 2: Dynamic Schema Injection
Modify the `agent-runtime` so that during the wake cycle, it reads the agent's assigned role. It must then query a `ToolRegistry` to dynamically construct the exact JSON schema of allowed tools to pass to the LLM API.

### Step 3: Execution Gating
Refactor `action-queue.ts`. When the LLM attempts an action (e.g., `{"type": "shell"}`), the queue must verify that the requested tool is explicitly mapped to the agent's current role before execution.

## 4. Proposed Toolset Mapping

The ~21 capabilities from upstream will be categorized and distributed across specific stewardship roles:

### The Codebase Steward (Dev Agent)
*   **Role:** Navigating the AST, refactoring, fixing bugs, and managing the Git tree. Never accesses the broader internet.
*   **Tools:** `ctx_read`, `ctx_search`, `write_file`, `git_commit`, `run_tests`, `spawn_scribe` (for reviewing large files).

### The Infrastructure Steward (DevOps/SRE)
*   **Role:** Managing the host machine, interacting with deployments, and restarting crashed workers. High trust, high security.
*   **Tools:** `shell`, `remote_exec` (SSH), `docker_status`, `restart_service`, `alert_human`.

### The Personal Assistant
*   **Role:** Information retrieval, scheduling, and internet research. Zero access to the local filesystem or shell execution.
*   **Tools:** `web_search`, `rag_search` (Vector DB), `todo_add`, `todo_list`, `snooze_task`, `chat_post`.

## Conclusion
By implementing Stewardship-Based Tooling, `mini-volition` doesn't just catch up to upstream capabilities—it actively improves upon them. It ensuresthat when agents regain powerful tools like `shell` and `web_search`, they operate within strict, governable boundaries built on top of a highly durable, SQLite-backed message passing layer.