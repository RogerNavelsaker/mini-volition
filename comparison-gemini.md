Here is an analysis and review comparing the current codebase (`mini-volition`) with the upstream repository (`AIndoria/volition`), focusing on their similarities, differences, underlying philosophies, and relative strengths and weaknesses.

### 1. High-Level Overview & Philosophies

**Upstream (`volition`)**
- **Language/Runtime:** Python (using `asyncio`).
- **Philosophy:** Built around the **GUPPI Loop Architecture**. It uses a refractory scheduler that gates workloads during "cooldown windows" to preserve thinking space and avoid runaway agent loops. 
- **Infrastructure:** Relies heavily on external infrastructure like **Redis** (for pub/sub streams, distributed locking, and job queues like `queue:gpu_heavy`) and **ChromaDB** (for vector memory).
- **Structure:** Monolithic daemon architecture. The main `guppi.py` file is a massive (2500+ line) script handling everything from API routing and governor rate-limiting to specific tool implementations (e.g., `spawn_roamer`, `spawn_scribe`).

**Current Codebase (`mini-volition`)**
- **Language/Runtime:** TypeScript running on **Bun**.
- **Philosophy:** **Local-First & Harness-Authority**. The "Body" (harness) owns all transport, wakes, and validation, while the "Mind" (agent) owns reasoning. It enforces a strict **SplitBrain** pattern where inference is offloaded to dedicated local Unix socket workers (`inference-local-embed`, `inference-local-small`, etc.) or cloud providers.
- **Infrastructure:** **Zero-dependency infrastructure**. It entirely drops Redis and vector DBs in favor of **SQLite** (for hotpath acceleration) and **JSONL/TOML** (for durable, append-only canonical state). 
- **Structure:** Highly componentized into specific domains (`agent-runtime`, `agent-jobs`, `agent-mail`, `agent-memory`, `fleet`).

---

### 2. Key Similarities

- **Autonomous Multi-Agent Focus:** Both codebases are designed to run asynchronous, autonomous LLM agents that manage their own tasks, memory, and communications.
- **Task Offloading (SplitBrain):** Both recognize that heavy lifting shouldn't block the main agent loop. Upstream uses `spawn_scribe` (for analysis/summarization) and `spawn_roamer` (for investigation), while `mini-volition` uses dedicated background socket workers and sub-agent delegation.
- **SQLite for Fast State:** Both utilize SQLite databases for immediate local state (e.g., `TODO_DB` upstream; `agent-jobs.db` locally).
- **Communication Protocols:** The concept of "Fleet Protocols" (channel integrity, explicit reply rules) applies to both, dictating how agents communicate over synchronous vs. asynchronous channels.

---

### 3. Key Differences

| Feature | Upstream (`volition`) | Current (`mini-volition`) |
| :--- | :--- | :--- |
| **State & Durability** | Mutates state directly in SQLite/Redis. Relies on Redis TTLs for locks. | **Projection-based**. Durable JSONL append-first logs are canonical. SQLite is merely a rebuildable hotpath view. |
| **IPC / Transport** | Redis streams (`volition:social_digests`) and task queues. | **Unix Sockets** for RPC/inference + SQLite polling for mail/jobs. |
| **Modularity** | Monolithic daemon (`guppi.py`) executing all core logic. | Highly modular binaries (`agent-mail`, `agent-state`, `fleet-librarian`) compiled to `bin/`. |
| **Developer UX** | Raw Python scripting and manual execution. | Formal CLI workflows (`sd` for seeds/issues, `tl` for trellis/specs, `ml` for mulch/knowledge) integrated with `git`/`gh`. |

---

### 4. Strengths & Weaknesses

#### Upstream (`volition`)
* **Strengths:**
  * **Ecosystem:** Python has unparalleled out-of-the-box support for AI tooling (ChromaDB, Trafilatura for web scraping, aiohttp).
  * **Robust Messaging:** Redis solves the hard problems of pub/sub, cross-process locking, and reliable queues immediately.
* **Weaknesses:**
  * **Operational Complexity:** Requires a running Redis instance and managing ChromaDB persistent storage, making it harder to deploy or spin up in isolation.
  * **Monolithic Fragility:** Massive files like `guppi.py` mix protocol logic, network logic, and tool execution, making it brittle to refactor.

#### Current Codebase (`mini-volition`)
* **Strengths:**
  * **Extreme Portability & Cohesion:** By restricting the stack to Bun and SQLite, the fleet can run entirely local with zero external container dependencies.
  * **Bulletproof State:** The append-only JSONL architecture (Event Sourcing / Petiole pattern) means no database migrations are ever needed. If a schema changes, the SQLite DB is simply rebuilt from the raw event log.
  * **Component Isolation:** If `agent-mail` crashes, `agent-memory` isn't taken down with it. Unix sockets enforce strict boundaries.
* **Weaknesses:**
  * **Reinventing the Wheel:** By dropping Redis, `mini-volition` has to manually implement and manage cross-process locking, pub/sub polling, and queueing mechanics over SQLite, which can introduce edge cases.
  * **TypeScript AI Ecosystem:** While improving, TS/Bun lacks some of the hyper-specialized AI/Vector libraries that Python enjoys, requiring models to be exposed via local ONNX wrappers over sockets.