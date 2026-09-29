# Memory / Retrieval Plan

## Purpose

This document captures the current architectural plan for `mini-volition` memory/retrieval work.

It is a working implementation plan.
It is a working design plan based on the decisions made so far.

The guiding direction is:

- prioritize `recall > provenance > multi-hop > latency`
- keep graph auxiliary
- keep bounded replicant agency
- use local workers for deeper retrieval/planning
- preserve harness authority over normalization, storage, and final quality signals
- favor runtime agency with role-scoped boundaries and low ceremony
- where a tool family is real and stable, use a `<family> <verb> <jsonl>` public surface over unrelated top-level verbs

## Design stance

This system is a steward runtime with memory.

It is a steward runtime with memory.
Memory exists to improve continuity, recall, grounding, reviewability, and bounded reasoning during live turns.

The memory system must support:

- wake-time continuity
- task handling
- debugging/forensics
- bounded retrieval expansion
- durable review/audit

It must stay anchored on:

- bounded retrieval expansion
- graph as auxiliary evidence
- prepared bundles as evidence
- honest qualitative confidence signals
- role-scoped runtime capability with minimal ceremony

## Scope boundary

This plan focuses on v1 runtime/tool behavior and canonical state.

It assumes the surrounding runtime environment provides the enforcement needed for the enabled replicant classes.

So this document must define:

- runtime/tool shape
- role/class intent
- retrieval/memory behavior
- normalization, audit, and review semantics

It leaves these concerns to surrounding layers:

- low-level enforcement mechanics
- process isolation internals
- platform-specific availability gates

## Harness core

These items are in-scope for the harness/runtime plan because they affect durable coordination, mailboxing, and the shape of canonical state.

### Message substrate

- use SQLite in WAL mode for durable, low-latency state coordination and mailboxing
- keep hotpath reads/writes queryable through SQLite while append-only logs remain canonical
- preserve harness ownership of normalization and final record shape

### Log projection

- use append-only JSONL as the canonical ground truth for events and state transitions
- use SQLite as the materialized projection for high-performance retrieval and coordination
- keep projection rebuildable from the canonical log
- keep the log as the source of truth when projection and log disagree
- keep projection-specific indexes and query paths harness-internal

### Implementation order

1. Define the canonical JSONL event schema.
2. Define the SQLite projection tables and replay rules.
3. Wire mailbox/coordination paths onto the projection.
4. Add rebuild/repair flows from JSONL back into SQLite.
5. Validate that turn, mail, and task coordination all survive projection rebuilds.

### Inference boundary

- keep the current inference frontend contract stable while treating model execution as a backend detail behind that contract
- keep request/response envelopes, socket-facing behavior, and harness validation consistent even if the execution backend changes later
- keep transport-specific assumptions outside the public tool surface

### Harness/API surface map

Current runtime binaries that carry the harness/API boundary:

- `replicant-runtime`: primary harness CLI; turn assembly, wake selection, dispatch, recovery, and action normalization
- `replicant-mail`: message transport and mailbox projection
- `replicant-scheduler`: scheduled jobs, alarms, local events, reclaim/replay
- `replicant-memory`: retrieval, facts, links, compaction, projection upkeep
- `replicant-state`: runtime state, health, subscriptions, notifications, recovery
- `conversation-reporter`: shared gossip/conversation monitoring and prepared digest/report/summary generation for turn context assembly
- `replicant-dreaming`: background memory upkeep, extraction, repair, compaction, and sleep/dream-style consolidation
- `fleet`: genesis, topology, governance, service lifecycle
- `operator-console`: human control plane
- `inference-local-*` and `inference-cloud-*`: provider frontends / execution adapters

Public API dispatcher:

- `replicant-tool`
- subcommands:
  - `memory`
  - `clipboard`
  - `todo`
  - `mail`
  - `chat`
  - `file`
  - `web`
  - `worker`
  - `replicant`
  - `human`
  - `shell`

Implementation target:

- keep these families surfaced through the harness contract, even when the backing module/CLI changes
- route all public family actions through the `replicant-tool` dispatcher
- use JSONL for harness→`replicant-tool` reqs, then decode to JSON inside the harness before validation and execution
- keep JSONL rows flat; one row = one action; request fields live at row top level
- use TOON for harness/model ctx and turn assembly
- use shared envelopes, normalized results, and stable req/res shapes over extra top-level binaries
- add new binaries only when process isolation or separate lifecycle actually matters

## Core architecture

### Retrieval center of gravity

- Retrieval is `mixed by query mode`
- Query modes are chosen through `hybrid routing`
- First pass stays cheap
- Deeper retrieval is handled by a local offload worker

### v1 vs later retrieval policy

- `v1` uses a shared retrieval core across all replicant classes
- later iterations can add thin class-specific retrieval defaults only after the shared core is hardened through real usage

The replicant receives concrete retrieval/search choices and keeps agency over retrieval intent.

Direction:

- expose concrete retrieval/search actions
- let the replicant choose among them
- keep the harness responsible for normalization, budgets, and safety boundaries

This is closer to “simple but powerful” than one over-abstracted `search_everything` tool.

### Priority ranking

- `Recall` first
- `Provenance` second
- `Multi-hop reasoning` third
- `Latency` fourth

### Graph role

- Graph remains `auxiliary`
- Graph stays auxiliary in v1
- `graph_assist` stays worker-only

## Query modes

### First-pass modes

v1 first-pass modes:

- `artifact`
- `summary`
- `fact`
- `hybrid`

### Worker-only mode

- `graph_assist`

### Tool-surface direction

With a shared retrieval core in v1, the tool surface stays concrete and replicant-readable.

Current direction:

- expose concrete knowledge/retrieval choices to the agent
- allow the replicant to choose the retrieval/search path explicitly
- keep richer multi-step expansion/offload behavior available behind bounded worker flows
- keep the broader replicant-harness posture oriented around real steward work
- use exposing real execution/mutation/inspection powers to the appropriate replicant classes when the outer substrate can sandbox and audit them
- preserve main replicant capability and rely on substrate capability boundaries for safety

The eventual tool surface preserves the upstream spirit of one simple retrieval entrypoint with intent carried by the request.

V1 retrieval/search tool set:

- `memory recall`
- `web search`
- `web read`

These names are the current v1 direction; implementation evidence can justify a clearer alternative.

`memory recall` must use the shared outer envelope with `request_id`, `status`, optional `detail`, and `content`.
Normal `memory recall` outcomes are terminal: `completed`, `rejected`, or `failed`.
Normal synchronous memory-search statuses in v1 are `completed`, `rejected`, and `failed`.
`memory recall` must follow the shared flat JSONL row convention:

- single request form is one flat JSONL row
- multi-request form uses multiple flat JSONL rows
- each JSONL row/object is a separate memory recall req and must stay flat
- each request receives its own result envelope
- each row receives its own envelope
- batched memory recall requests can be scheduled independently and complete out of order

`memory recall` request shape:

- `query`
- optional `limit`
- optional `after`
- optional `before`

`memory recall` results must be compact and text-bearing by default.
`memory recall` result `content` must be an object:

- `datetime`
- `entries`
- optional `unapplied`

Result entries include enough text for immediate recall in one read.
`memory recall` returns evidence entries; synthesis belongs to the replicant or worker.
The replicant reads the returned entries and decides how to synthesize or whether to offload deeper reasoning.
Entries are returned in harness-selected order; numeric rank, relevance, and confidence scores stay internal by default.
Raw retrieval distances, rank scores, and vector-specific scores remain internal.
When requested bounds, selectors, or retrieval helpers are unapplied, `memory recall` reports compact `unapplied` details in `content` and still returns useful partial results.
Likely entry fields:

- `type`
- `title` or short label
- `content` or excerpt
- `source_ref`
- optional `datetime`

Initial `type` values:

- `semantic`
- `episodic`
- `procedural`
- `artifact`
- `mail`
- `chat`
- `file`

Each memory recall entry must expose exactly one primary `type` in v1.
`artifact` means a path-backed durable object known through memory.
`mail`, `chat`, and `file` mean memory records that originated from those surfaces.
`source_ref` must be human-readable when the source is naturally readable, such as a path, mail id, chat id, or artifact ref.
Opaque harness refs remain allowed for records with synthetic source identity.

The tool surface must stay simple:

- one public query verb
- intent comes from the replicant's query and current turn context
- the harness helps internally while the replicant states retrieval intent

Upstream-style retrieval posture must also be restored in genesis/prompt doctrine:

- before broader exploration or external web work, genesis/prompt doctrine must steer the replicant toward checking its own query/memory surfaces first
- this is the nearest v1 equivalent to upstream `rag_search`-first behavior
- the genesis/prompt materials state that protocol explicitly
- genesis must follow the upstream cortex split: the core genesis prompt is only the constitution, while supporting doctrine lives in separate docs that are injected or made available as part of the genesis package
- active doctrine is adapted from the upstream split-doc set

Internal retrieval posture must start strong with graceful fallback:

- replicant uses `memory recall` based on intent
- the harness helps internally while the replicant states retrieval intent
- `memory recall` can internally use a strong hybrid posture when the result needs it:
  - semantic retrieval
  - lexical/keyword retrieval
  - temporal retrieval
  - optional graph-assist traversal
- the harness can internally bias toward artifacts, summaries, facts, or hybrid fusion as needed
- low-yield retrieval strategies produce graceful fallback and useful partial results
- graph remains auxiliary and internal
- `memory recall` is for harness-managed memory/knowledge retrieval
- local or remote file/artifact searching must remain under shell/execution-oriented surfaces, closer to the upstream `shell` / `remote_exec` split and represented in v1 as a `shell <verb>` family such as `shell local` and `shell remote`

Current v1 bounded defaults:

- `memory recall` default `limit = 10`
- `web search` default `limit = 5`

In both cases:

- the replicant can explicitly request more
- the harness can clamp and must report that honestly

### Web tool direction

`web search` and `web read` are plain peer tools.

Current v1 direction:

- `web search` stays query-like
- `web read` stays URL/read-specific
- neither must be hidden behind `worker invoke`
- web results must use the shared outer envelope with `request_id`, `status`, optional `detail`, and `content`
- normal web outcomes are terminal: `completed`, `rejected`, or `failed`
- normal synchronous web statuses in v1 are `completed`, `rejected`, and `failed`

`web search` request shape must stay close to the internal query family:

- `query`
- optional `limit`
- optional `after`
- optional `before`

`web search` must follow the shared flat JSONL row convention:

- single request form is one flat JSONL row
- multi-request form uses multiple flat JSONL rows
- each JSONL row/object is a separate search req and must stay flat
- each request receives its own result envelope
- each row receives its own envelope
- batched search requests can be scheduled independently and complete out of order

Current v1 behavior:

- default result limit is `5`
- the replicant can request a larger `limit`
- return titles and URLs only by default
- return titles and URLs by default
- snippets can be included when explicitly requested
- `after` and `before` are best-effort and surface through `unapplied` when unapplied

`web read` request shape must stay plain:

- `url`
- optional `format`

`web read` must follow the shared flat JSONL row convention:

- single request form is one flat JSONL row
- multi-request form uses multiple flat JSONL rows
- each JSONL row/object is a separate read req and must stay flat
- each request receives its own result envelope
- each row receives its own envelope
- batched read requests can be scheduled independently and complete out of order

Current v1 behavior:

- default `format` is `markdown`
- supported `format` values are `markdown`, `text`, and `raw`
- only `http` and `https` URLs are accepted
- local files or other URI schemes must be handled through `file` or `shell` surfaces
- ordinary redirects are followed by default
- final URL must be reported in `content`
- minimal source metadata must use `final_url`, optional `title`, and common `datetime`
- redirects to unsupported or suspicious targets must fail closed
- return markdown inline when it fits
- remain read-only
- support read-only fetch/extract workflows

`web read` can automatically persist fetched content when inline return exceeds the inline contract, for example when the page is:

- too large for inline return
- poor in readability
- non-text-like
- high in extraction complexity

When spill/persistence is needed:

- the tool can write to local `downloads` or `overflow` storage
- the choice between those locations is automatic
- the replicant is told the returned local path
- storage class stays harness-internal
- truncation/boundedness must still be reported explicitly through the shared result contract
- spill details must live inside `content`, for example `path`, optional `summary`, and optional `truncated`

Persisted web content must remain a file/path-oriented workflow at first:

- the replicant can pass the returned path directly to `worker invoke`
- the replicant can use ordinary shell/file tooling on it when appropriate
- raw spill files become file/path artifacts first

Forms, logins, and browser-action workflows belong to future personal-assistant domain tools. `web read` stays read-only.

V1 memory/task tool sets:

- clipboard:
  - `clipboard read`
  - `clipboard append`
  - `clipboard replace`
  - `clipboard remove`
  - `clipboard clear`
- todo/tasks:
  - `todo list`
  - `todo add`
  - `todo complete`
  - `todo remove`
  - `todo snooze`

### Shared result-quality direction

`memory recall` and `worker invoke` must report result-quality semantics in a consistent way.

The design goal is:

- surface useful quality and boundedness signals to the agent
- if something was unapplied, bounded, lower-fidelity, or partial, say so explicitly
- let the harness report honestly
- let the replicant interpret and choose
- expose timing provenance through a common `datetime` field in `content`

This applies across both:

- direct retrieval/search
- asynchronous offload results

`datetime` must be required in `content` for read/search/history/list-style results, including:

- `memory recall`
- `web search`
- `web read`
- `mail history`
- `chat history`
- `file read`

`clipboard read` and `todo list` return current-surface shapes and rely on turn-level datetime.
`datetime` can also be included for execution results when the result needs it, such as `shell local` or `shell remote`.
Pure mutation acknowledgments omit `datetime` by default; substantive returned state includes it.

Read/search/history/list-style result `content` must generally use a small wrapper object:

- `datetime`
- a domain-appropriate payload field, such as `entries`, `results`, or `body`
- optional `unapplied`

The wrapper pattern is shared; the inner payload field stays domain-appropriate.

Turn-context assembly must include a harness-owned current runtime datetime on every turn.
Output datetime values must use ISO 8601 with an explicit offset, for example `2026-04-30T14:25:00+02:00`.
Input time selectors use a bounded ergonomic parser: full ISO 8601 with offset is canonical, date-only values are accepted, and time-only values are interpreted as today in the local runtime context.
The harness normalizes accepted input selectors internally.
Replicant-facing v1 time selectors are ISO, date-only, or time-only.
Human/operator interfaces can add fuzzy natural-language time selectors.
The runtime datetime is the authoritative clock for wake duration, due-task reasoning, mail/chat freshness, and audit comparison.
Harness-injected context can rely on the turn-level current datetime when the injected content is assembled for that same turn.
The current runtime datetime must be injected as a separate labeled structured block.
Actual turn ctx must use short stable labels for recurring blocks:

- `[NOW]` for current datetime
- `[ORIENT]` for orientation/sleep-delta/catch-up state
- `[CLIP]` for active clipboard
- `[TODO]` for currently due todos
- `[MEM]` for injected memory
- `[BURST]` for current wake event/message batch
- `[WM]` for working memory
- `[REM]` for terse operational reminder

Short labels are runtime labels; long names such as `[CURRENT_DATETIME]`, `[ACTIVE_CLIPBOARD]`, `[CURRENTLY_DUE_TODOS]`, and `[REMINDER]` are documentation aliases.

Turn ctx must use bounded TDD:

- stable labeled blocks first, terse payload second
- JSON for current-state blocks where stable field names matter
- TOON-style rows for repeated/tabular records that benefit from compact field headers
- explicit empty shapes such as `entries: []`
- warning fields inside the relevant JSON block
- behavioral doctrine lives in system prompt/docs and is referenced by compact ctx markers

Prompt-cache stability is part of the design:

- static doctrine/docs must precede dynamic turn ctx
- volatile sections must be appended after cached doctrine in stable order
- short labels reduce recurring token overhead
- changing early static text must be treated as cache-invalidating
- provider cache metrics must be logged during impl where available
- provider-specific cache metadata stays in harness logs

`[NOW]` content must be `{ "datetime": "..." }`.
`[CLIP]` content must be `{ "entries": [], "warning": "optional" }`.
`[TODO]` content must be `{ "entries": [], "truncated": false, "remaining": 0 }` when relevant.
`[BURST]` must use compact rows with fields such as `datetime`, `source`, `sender`, `layer`, and `content`.
`[REM]` must stay terse, for example `[REM] budget=8000 reply→private→operator envelope=json`.

### Broader plain-tool posture

The retrieval/search surface is only one part of the v1 tool shape.

The broader runtime tool posture stays plain and concrete.

Likely concrete tool families outside retrieval include:

- communication tools such as `mail send`, `mail history`, `chat post`, `chat history`, `chat subscribe`, `chat unsubscribe`, `human notify`, and `human alert`
- bounded execution tools for the appropriate replicant classes
- bounded file mutation tools for the appropriate replicant classes
- task/memory tools for clipboard and todo/task handling

The exact final list and naming remain subject to implementation, but the direction is explicit:

- plain tools
- replicant chooses
- harness validates and records
- concrete family tools with replicant choice

For file mutation, v1 must use a simple public family:

- `file read`
- `file edit`
- `file write`

File tools must use the shared outer envelope with `request_id`, `status`, optional `detail`, and `content`.
Normal file tool outcomes are terminal: `completed`, `rejected`, or `failed`.
Normal synchronous file statuses in v1 are `completed`, `rejected`, and `failed`.
Top-level `status` remains operational routing; result material and human-readable explanations stay in `content`.

The family must follow the same public request convention as the rest of v1:

- single request form must be one flat JSONL row
- multi-request form must use multiple flat JSONL rows
- each JSONL row/object is a separate file req and must stay flat
- each request receives its own result envelope
- each row receives its own envelope
- batched file requests can be scheduled independently and complete out of order

`file read` must remain a real public tool in v1.
It is the source of stable line-hash anchors for later file mutation.
`file read` is text-only in v1.
Binary or non-text reads must return `rejected` with `detail = unsupported_type`.
`file read` must always return line-hash-tagged output by default.
`file read` must default to a bounded first window of 2000 lines.
Optional `after` and `limit` select a follow-up window after a known line anchor.
`after` is exclusive: the returned window starts after the anchor line.
When `after` fails current-file verification, `file read` returns `rejected` with `detail = anchor_invalid`.
`file read` v1 supports `after` plus `limit` windowing.
Oversized reads are bounded by the harness.
Those line-hash anchors are stable for the whole file across returned views/windows.
`file read` must stay minimal by default:
- resolved absolute path
- line-hash-tagged content
- optional `after` / `limit` echo when windowing is used
`file read` result `content` must use:
- `datetime`
- `path`
- `lines`
- optional `after`
- optional `limit`
- optional `truncated`
- optional `total_lines`
- optional `unapplied`
`lines` must be an ordered array of `{ anchor, text }` objects.
`total_lines` must be included only when known or cheap to compute.
Line anchors must be 4-character stable hash anchors in the formal v1 API.
Line anchors must be unique within the file.
Repeated line text is disambiguated by harness-generated anchors.
Anchors are valid when they verify against the current file state.
Fresh `file read` provides authoritative anchors after arbitrary edits.
After edits, a fresh `file read` is the source of truth for new anchors when needed.
Replicant-facing `file read` output uses anchors and text.
`file edit` consumes stable anchors plus new text.
At edit time, the harness must also perform enough contextual verification to detect stale anchors or accidental collisions before mutating the file.
Anchors can be reused across turns if the replicant still has them available in working context and they continue to verify at edit time.
When an edit anchor fails verification, `file edit` returns `rejected` with `detail = anchor_invalid`.
The expected recovery path is to re-read and then retry the edit.
`file edit` must follow the shared flat JSONL row convention:
- single edit requests use one flat JSONL row
- multiple edit requests use multiple flat JSONL rows
`file edit` must use a small explicit operation field in its payload:
- `replace`
- `insert_before`
- `insert_after`
Deletion is expressed as `replace` with empty text.
Each `file edit` JSONL row/object must target one edit site only and must stay flat.
That target can be:
- a single replacement anchor using `anchor`
- an anchored replacement range using `from` and `to`
Insert operations must target a single position anchor using `before` or `after`.
Replace operations can use either a single `anchor` or an anchored range with `from` and `to`.
Inserted or replacement text must use the `text` field.
`file edit` is line-oriented in v1.
`text` represents complete inserted or replacement line content for the targeted line or range.
`text` can contain one or more lines and is applied exactly as supplied.
`file edit.text` accepts text; trailing newline is optional.
The harness handles line boundaries for line-oriented edits and preserves final-file newline policy when the tool semantics support it.
v1 edit selectors are line-oriented anchors and anchor ranges.
`replace` with empty text removes the targeted line or range entirely.
Appending to end-of-file must normally be expressed as `insert_after` on the last available anchor.
Empty files use `file write` for first content.
Successful `file edit` results stay compact and omit changed anchors by default.
Successful `file edit` content can include a compact mutation summary:
- `path`
- `edited`
- optional `operations`
When fresh anchors are needed after mutation, the replicant can call `file read`.
`file write` uses overwrite-by-default semantics in v1 and creates missing files.
`file write` must also auto-create parent directories by default.
`file write` remains whole-file/new-file oriented and consumes path plus content.
Successful `file write` content can include a compact mutation summary:
- `path`
- `written`
- optional `bytes`

The harness must own the hard part:

- stable anchoring for edits
- verification before mutation
- retries/fallbacks
- model-agnostic edit reliability

Hashline-style anchoring or equivalent stable line-anchor strategies stay harness-internal implementation doctrine.

### Turn context TDD assembly

The same bounded TDD style used in `docs/` must apply to harness-assembled turn context because the replicant reads this material every ordinary turn.

Current direction:

- context assembly must use stable short labels and terse payloads
- repeated prose reminders are omitted when the system prompt/docs already define behavior
- TOON is used for flat/repeated rows
- JSON request rows are flat only; nested request payloads are invalid
- keep empty states explicit through stable shapes such as empty TOON tables or `entries: []`
- put warnings inside the relevant block payload
- keep static doctrine/docs before dynamic turn context so provider prompt caches can reuse the largest stable prefix
- append volatile sections after cached doctrine in stable order
- changing early static text must be treated as cache-invalidating
- provider cache metrics must be logged during implementation where available
- provider-specific cache metadata stays in harness logs

Turn context labels must use short stable names:

- `[NOW]`
- `[ORIENT]`
- `[CLIP]`
- `[TODO]`
- `[MEM]`
- `[BURST]`
- `[WM]`
- `[REM]`

Long aliases remain documentation-only names:

- `[NOW]` means `[CURRENT_DATETIME]`
- `[CLIP]` means `[ACTIVE_CLIPBOARD]`
- `[TODO]` means `[CURRENTLY_DUE_TODOS]`
- `[REM]` means `[REMINDER]`

Current runtime compatibility:

- `§SCRATCHPAD` can remain while implementation still uses scratchpad storage/action naming
- v1-facing doctrine must treat it as the clipboard surface
- transition target is `[CLIP]`

Required context examples:

```toon
todo[4]{id|content|due}:
  124|"review prompt cache plan"|"2026-05-01T12:00:00+02:00"
```

```toon
clipboard[2]{index|content}:
  1|"Use [NOW]/[CLIP]/[TODO] short context labels"
  2|"Harness decodes TOON to JSON then validates schema"
```

```text
[REM] budget=8000 reply→private→operator envelope=toon
```

This is an implementation target for later coding; this planning pass records the runtime contract.

For shell execution, v1 must use a simple public family:

- `shell local`
- `shell remote`

`shell local` and `shell remote` are execution-only surfaces.
They return command output as execution evidence.
Line-hash guarantees belong to `file read`.

`shell local` request shape:

- `command`
- optional `cwd`
- optional `timeout`

If `timeout` is omitted, the harness applies a default timeout.

`shell remote` request shape mirrors `shell local` with one additional required placement field:

- `target`
- `command`
- optional `cwd`
- optional `timeout`

`shell remote.target` is an explicit remote execution target.
It can be a direct SSH-like target such as `user@host`, or a harness-known alias resolved by the substrate.
Alias creation, editing, and removal are external configuration/substrate concerns in v1.
The public contract treats remote execution as a target abstraction; SSH-like targets are one supported form, while transport choice remains harness/substrate internal.

`shell local` and `shell remote` must follow the shared flat JSONL row convention:

- single request form is one flat JSONL row
- multi-request form uses multiple flat JSONL rows
- each JSONL row/object is a separate shell execution req and must stay flat
- each request receives its own result envelope
- each row receives its own envelope

JSONL shell batches are independently schedulable by default.
Results can complete out of order and must be correlated by `request_id`.
Ordered/dependent command execution uses ordinary shell sequencing or scripts in v1.

Shell result shape must use the shared outer envelope when the tool semantics support it.
The shell execution facts must live in `content`:

- `stdout`
- `stderr`
- `exit_code`
- `duration_ms`

Communication must stay split and concrete:

- private inbox-style messaging as a plain primitive
- public chat/broadcast as a separate plain primitive
- human notify/alert as separate plain primitives

Current upstream-aligned distinction:

- directed mail/inbox traffic is expected to act as a stronger wake/context signal
- relevant direct mail must normally arrive through harness turn-context assembly when it matters
- public chat is noisier and more ambient, so digesting and explicit lookback matter more there
- explicit `chat history` remains especially important for ambient social lookback

In v1, the communication layer must stay split and concrete:

- `mail send` for private inbox-style delivery
- `mail history` for deliberate private inbox/mail lookback when needed
- `chat post` for public/shared-channel posting
- `chat history` for deliberate public/shared-channel lookback when needed
- `chat subscribe` for joining additional public/shared chat streams
- `chat unsubscribe` for leaving additional public/shared chat streams
- `human notify` for non-urgent human-directed communication through the normal operator-harness async inbox/mail flow
- `human alert` for urgent escalation through an external alerting substrate (for example mobile/email/push outside the operator CLI)

`mail send` and `chat post` must use the shared outer envelope with `request_id`, `status`, optional `detail`, and `content`.
Normal send/post outcomes are terminal: `completed`, `rejected`, or `failed`.
Normal synchronous send/post statuses in v1 are `completed`, `rejected`, and `failed`.
`mail send` and `chat post` must follow the shared flat JSONL row convention:

- single request form is one flat JSONL row
- multi-request form uses multiple flat JSONL rows
- each JSONL row/object is a separate send/post req and must stay flat
- each request receives its own result envelope
- each row receives its own envelope
- batched send/post requests can be scheduled independently and complete out of order

Successful `mail send` content can include `recipient` and optional `id`.
Successful `chat post` content can include `channel` and optional `id`.

`mail send` must be available to all three classes by default.
`mail history` must also exist in v1 for parity and deliberate inbox lookback, even though direct mail is normally expected to surface through turn-context assembly when relevant.
`mail history` must use the shared outer envelope with `request_id`, `status`, optional `detail`, and `content`.
Normal `mail history` outcomes are terminal: `completed`, `rejected`, or `failed`.
Normal synchronous history statuses in v1 are `completed`, `rejected`, and `failed`.
Valid queries with empty matches return `completed` with empty `entries`.
Invalid sender or recipient identifiers must return `rejected` with `detail = input_invalid`.
`mail history` must use the same bounded request shape as `chat history`:

- default `limit` applies by default; explicit `limit` overrides it
- maximum `limit` must stay bounded at `20`
- `limit`
- optional `sender` list
- optional `recipient` list
- optional `after`
- optional `before`
- filters stay simple in v1

`mail history` must follow the shared flat JSONL row convention:

- single request form is one flat JSONL row
- multi-request form uses multiple flat JSONL rows
- each JSONL row/object is a separate history req and must stay flat
- each request receives its own result envelope
- each row receives its own envelope
- batched history requests can be scheduled independently and complete out of order

`mail history` result `content` must use the shared history wrapper:

- `datetime`
- `entries`
- optional `unapplied`

`mail history` entries must be compact, ordered, and text-bearing.
Entries must be newest-first by default.
No explicit order override is part of v1.
Likely entry fields:

- `id`
- `datetime`
- `sender`
- `recipient`
- `content`
- optional `refs`

`after` and `before` must use explicit datetime-formatted values.
If only a time is supplied, it must be interpreted relative to today in the local runtime date context.
Policy gating must stay light:

- allow sending to known peer agents
- allow sending to self
- allow sending to the operator/human
- reject unknown or invalid recipients at the runtime boundary

`chat post` is available to all three classes by default, and public/shared chat stays split by steward class.

`chat history` must preserve upstream parity at minimum and can use a slightly richer bounded request shape in v1:
`chat history` must use the shared outer envelope with `request_id`, `status`, optional `detail`, and `content`.
Normal `chat history` outcomes are terminal: `completed`, `rejected`, or `failed`.
Normal synchronous history statuses in v1 are `completed`, `rejected`, and `failed`.
Unknown or invalid channels must return `rejected` with `detail = input_invalid`.
Known channels with empty matches return `completed` with empty `entries`.

- default `limit` applies by default; explicit `limit` overrides it
- maximum `limit` must stay bounded at `20`
- `channel`
- `limit`
- optional `participant` list
- optional `after`
- optional `before`
- filters stay simple in v1

`chat history` must follow the shared flat JSONL row convention:

- single request form is one flat JSONL row
- multi-request form uses multiple flat JSONL rows
- each JSONL row/object is a separate history req and must stay flat
- each request receives its own result envelope
- each row receives its own envelope
- batched history requests can be scheduled independently and complete out of order

`chat history` result `content` must use the shared history wrapper:

- `datetime`
- `entries`
- optional `unapplied`

`chat history` entries must be compact, ordered, and text-bearing.
Entries must be newest-first by default.
No explicit order override is part of v1.
Likely entry fields:

- `id`
- `datetime`
- `channel`
- `participant`
- `content`
- optional `refs`

`refs` must be a simple string list in v1.
Entries can point to related paths, artifact refs, URLs, worker output refs, or other follow-up material.

`after` and `before` must use explicit datetime-formatted values.
If only a time is supplied, it must be interpreted relative to today in the local runtime date context.

This also aligns with the upstream Ear/social-digest pattern:

- missed public/social chat is summarized into digest-like context on wake
- explicit `chat history` is then used sparingly for deliberate lookback beyond what the digest or current event already surfaced

Current direction:

- separate public chat channels per steward class
- one shared cross-class public channel
- public chat remains distinct from inbox-style private delivery
- ad-hoc public chat channels are allowed
- any valid `chat:*` channel name can be used

Current v1 public chat channels:

- `chat:devops`
- `chat:code`
- `chat:assistant`
- `chat:general`

Default subscription rule:

- each replicant subscribes to its class channel
- each replicant subscribes to `chat:general`
- agents subscribe to their own class channels by default
- agents can subscribe to additional valid `chat:*` channels when needed

Temporary unsubscribe behavior must be explicit:

- for default channels (`chat:general` and the replicant’s class channel), if the replicant unsubscribes, the replicant-harness must automatically create a reminder task to rejoin later
- this reminder must appear in the replicant’s normal todo/task system
- for ad-hoc channels, unsubscribe behavior remains replicant-driven
- the replicant receives clear feedback that unsubscribing from an ad-hoc channel is temporary by default if it intends to return

### First-pass hybrid meaning

First-pass `hybrid` means:

- `FTS + vector`
- first pass uses direct evidence
- first pass uses simple ranking

Structured influence starts after escalation/offload.

## Routing policy

### Routing ownership

- Harness chooses the initial mode
- A small local classifier assists routing
- Deterministic rules remain in control where query shape is obvious
- The model can use one bounded insufficiency vote

### Routing model

The local classifier returns:

- `mode`
- `confidence`

Low-confidence classifier output falls back through:

1. deterministic rules
2. unresolved -> `hybrid`

### Deterministic rules

Rules can directly force:

- `summary`
- `fact`
- `artifact`

Rules guide routing; query content selects `hybrid` when warranted.
`hybrid` remains the ambiguity lane.

## First-pass mode behavior

### Summary mode

- defaults to a `recent window`
- recent window widening is worker-only
- prepared bundles can be used first
- prepared bundles are `non-canonical`
- prepared bundles require corroboration when bundle quality or confidence is weak

Authority ranking for `summary`:

- `bundle-first with corroboration policy`
- then durable summaries/compactions
- bundle-only authority is rejected

Freshness weighting in `summary`:

- `strong`

### Fact mode

- structured facts can lead
- attach text-bearing support when available
- text support is fetched after positive structured hit
- support fallback order:
  1. nearest source artifact
  2. summary
  3. compaction

Confidence must degrade when support comes from weaker fallback layers.

Authority ranking for `fact`:

- mode-conditional fact authority
- source-backed support raises authority and confidence

Freshness weighting in `fact`:

- `light`
- stronger freshness must be reserved for future explicit current-state subcases when required

### Artifact mode

- source artifacts are primary
- explicit degraded fallback is allowed
- fallback is marked degraded
- fallback can occur in first pass
- degraded artifact fallback returns bounded partial evidence
- degraded fallback lowers threshold for insufficiency vote

Authority ranking for `artifact`:

- `source artifacts with explicit degraded fallback`

Freshness weighting in `artifact`:

- `light`

### Hybrid mode

- hybrid has its own authority policy
- it is structured evidence
- it includes source and support context

Authority dimensions in `hybrid` v1:

- type
- support level
- freshness

Provenance quality remains future authority work.

Freshness weighting in `hybrid`:

- `medium`

## Budgets and escalation

### Budget model

Retrieval uses a `hybrid budget`:

- hard time budget
- hard retrieval-call budget

This uses budget-based ceilings with clear bounds.

### First pass vs offload

- Main replicant can answer directly from simple first pass
- Deeper retrieval is offloaded to a local worker
- Offload trigger is hybrid, with strong lean toward expensive-mode offload

### Expensive modes

Current lean:

- multi-query expansion must trigger offload
- broader structured reasoning bundles can later justify the same

### Weak evidence and escalation

Weak evidence uses:

- a tiny fixed rule table
- plus one bounded model insufficiency vote

Current v1 weak-evidence triggers:

- `fidelity = heavy`
- `confidence = low`
- `status = partial` and `content.type = content_ref`

The model can cast one bounded insufficiency vote using fixed reason codes.

Current fixed reason code set:

- `too_sparse`
- `too_stale`
- `wrong_granularity`
- `needs_relationships`
- `conflicting_evidence`
- `needs_source`

`needs_source` sits alongside `wrong_granularity`.
`needs_source` can be used cross-mode, including `artifact`.

When `needs_source` is used from non-artifact modes:

- offload goes to `worker hybrid with source preference`
- flexible artifact-aware offload

### Source preference during offload

In worker hybrid mode, source preference is:

- `phased`

Current shape:

1. strong source preference
2. if source results are sparse or weak, relax in one jump to broader hybrid

Relaxation uses heuristics in v1.

## Prepared bundles

Prepared bundles are useful, but dangerous if promoted to authority.

### Role of prepared bundles

- supporting context only
- auxiliary evidence objects
- can be consulted by worker for `summary` and `hybrid`
- scoped away from the general substrate for `fact` and `artifact`

### Bundle quality metadata

Prepared bundles carry explicit metadata where available.

Current v1 bundle metadata direction:

- `freshness`
  - raw timestamp(s) stored internally
  - coarse class available for reasoning:
    - `fresh`
    - `aging`
    - `stale`
- `source_count`
  - exact integer
- `coverage`
  - `narrow`
  - `adequate`
  - `broad`
- `provenance`
  - `none`
  - `partial`
  - `full`

### Bundle corroboration rubric

Bundle-led summary use must stay cheap and explicit.
The rubric remains metadata-based.

Current v1 weak-bundle triggers:

- `freshness = stale`
- `source_count < 2`
- `coverage = narrow`
- `provenance = none`

If a bundle is weak on any of those conditions:

- fetch at least one durable corroborating source before relying on it as the primary summary input

### Bundle influence

Prepared bundle allowed uses:

- support summary retrieval
- assist hybrid retrieval
- lightly bias lexical expansion

Prepared bundles contain:

- become top-level primary evidence
- control retrieval mode selection
- steer artifact/fact mode by default

### Bundle-driven lexical expansion

- lexical expansion only
- explicit mode fields
- maximum 3 added terms
- terms must be grounded directly in bundle content/metadata
- explicit terms
- bundle-derived terms are separately tagged in memo/audit

## Worker design

### Worker shape

v1 uses:

- a single general local retrieval worker

Not a specialist roster.

The worker can have internal modes such as:

- expand
- retrieve
- graph_assist
- rerank
- synthesize retrieval memo

Concurrent offload requests are allowed in v1.
Practical limiting comes from real resource policy and available capacity.

Where limits or pressure are encountered, that must be surfaced back to the replicant so it can:

- decide whether to invoke more workers
- decide whether to defer work
- decide whether to request more resources
- plan how to spend available resources

### Worker output

The worker returns:

- selected evidence
- grouped internal winners
- an operational memo
- support-structure hints for harness computation
- fidelity hints
- confidence hint from a fixed rubric

The main replicant sees:

- distilled retrieval summary
- normalized evidence

The raw worker memo is:

- stored durably
- summarized before main replicant injection in normal mode

### Worker memo

Normal memo level:

- operational

Rich traces are:

- debug/operator only

The memo must explicitly state:

- chosen mode
- queries used
- whether prepared bundles influenced retrieval
- whether corroboration was fetched
- group winners
- why group winners were selected
- stop reason
- budget consumed

### Worker retrieval result shape

- grouped results internally
- separate ranked pools before final fusion

The boundary layer normalizes selected results into a common evidence envelope.

## Evidence contract

### Evidence normalization

Internal retrieval can use native types.
The main replicant must receive normalized evidence envelopes.

### Evidence fields

Current direction for normalized evidence is operational, leaning strict.

Structured evidence must eventually carry richer metadata.

### Selection rationale

Selection rationale must remain internal to worker memo/audit in v1.

Current direction:

- keep per-item `selection_reason` internal
- let the main replicant use harness-selected evidence directly
- grounding penalties stay in separate result-quality fields

### Sources

Top-level results use a neutral universal `sources` field.

Current direction:

- replace `answer_basis`
- keep steering labels such as `single_item` / `multi_path` internal
- report sources neutrally across:
  - `memory recall`
  - `worker invoke`
  - `web <verb>`

`sources` is:

- top-level only
- mandatory when evidence exists
- absent for empty evidence
- absent on pure failure with diagnostic-only inline content

Current v1 shape is minimal:

- `sources.count`
- `sources.type`
- `sources.memory`

Current v1 source types:

- `artifact`
- `fact`
- `summary`
- `compaction`
- `web search`
- `web read`

Current v1 memory values:

- `working`
- `clipboard`
- `orientation`
- `episodic`
- `semantic`
- `external`

Current layer mapping decisions:

- `summary` -> `episodic`
- `compaction` -> `episodic`
- `fact` -> `semantic`
- `web search` / `web read` -> `external`

Additional reporting rules:

- `sources.count` counts returned evidence items after normalization
- externally referenced usable evidence still counts toward `sources.count`
- `sources.type` is always a list
- `sources.memory` is always a list
- `sources.type` lists all types present in returned evidence
- `sources.memory` lists all memory strata represented in returned evidence
- `sources.type` uses stable canonical order
- `sources.memory` uses stable canonical order

Current canonical `sources.type` order:

- `artifact`
- `summary`
- `compaction`
- `fact`
- `web read`
- `web search`

Current canonical `sources.memory` order:

- `working`
- `clipboard`
- `orientation`
- `episodic`
- `semantic`
- `external`

### Shared retrieval/offload/web result contract

The broad result-quality contract must be shared across:

- `memory recall`
- `worker invoke`
- `web <verb>` where the fields are semantically applicable

Where relevant, the harness surfaces shared quality signals across tool families.

Current direction for shared top-level result-quality fields includes:

- `status`
- `content` when the tool returns substantive body content
- `sources`
- `partial`
- `fidelity`
- `confidence`
- `unapplied`
- clamp/boundedness metadata where applicable

This is intentional.
The system surfaces ignored constraints and boundedness so the replicant can reason from explicit evidence.

Result-contract design must minimize replicant-facing `verbosity`.

Current direction:

- keep the top-level result surface small
- keep per-item metadata high value
- use explicit follow-up over bloated first responses

Returned evidence must be:

- ordered
- presented in ordered form with internal ranks

### Content

`content` is a conditional top-level field.

It appears only when a tool returns substantive body content or a reference to content that was externalized.

Current v1 direction:

- use `content` for result types carrying usable payload
- keep one shared payload slot across tool families

Current v1 content shape:

- `type`
  - `inline`
  - `content_ref`

When `content.type = inline`:

- the result carries inline body content
- `reason` is absent
- inline content can appear on:
  - `completed` results when the body is complete enough
  - `partial` results when the body is genuinely incomplete but still usable
  - `failed` results when the body is diagnostic/error reporting only

When `content.type = content_ref`:

- the result carries:
  - `path`
  - `reason`
- this is used when content was externalized from inline return
- `path` is absolute in v1
- `content_ref` implies `partial`
- this rule must hold consistently across:
  - `memory recall`
  - `worker invoke`
  - `web <verb>`

Current v1 persisted/externalized-content reasons:

- `too_large`
- `poor_readability`
- `non_text_like`
- `extraction_complexity`

This remains reusable across tool families.

### Status

Current direction:

- explicit status enum

Likely values:

- `not_available`
- `completed`
- `failed`
- `partial`

`worker invoke` must use the same honest result-quality posture as `memory recall`, including partial outcomes when work is incomplete but still useful.
`web <verb>` must reuse that same posture where the fields fit the tool semantics.

Status is mutually exclusive in v1.

Current interpretation:

- `not_available` = exceptional runtime/protocol failure to classify the result at all
- `completed` = usable and complete enough
- `partial` = usable but bounded or incomplete
- `failed` = empty usable result payload, even if diagnostic inline content exists

This means:

- diagnostic inline content can appear on `failed`
- externally referenced usable content surfaces as `partial`

### Partial

`partial` is top-level only in v1.

It must be structured and use fixed enum reasons.

Current v1 partial reasons:

- `clamped`
- `truncation`
- `insufficient_coverage`
- `time_window_limited`
- `source_unavailable`

`partial` and `fidelity` can both be present on the same result.
They represent separate dimensions.

### Unapplied

`memory recall` shares a common request shape in v1 and can accept hints such as:

- `query`
- `limit`
- optional `after`
- optional `before`
- optional `grounding`

`after` and `before` must use explicit datetime-formatted values.
If only a time is supplied, it must be interpreted relative to today in the local runtime date context.

`grounding` remains a narrow hint about what the replicant is trying to find or anchor against.

When a tool accepts a hint and leaves it unapplied, that fact surfaces explicitly.

Current direction:

- `unapplied` is conditional
- `unapplied` is a list of structured items
- each item includes:
  - `key`
  - `reason`

Current v1 unapplied reasons:

- `not_supported`
- `not_applicable`
- `policy_blocked`

This same broad unapplied reporting model applies to `worker invoke` and `web <verb>` when supplied hints are left unapplied.

### Clamp / boundedness feedback

The replicant can request `limit`, but the harness can clamp it.
This must be surfaced explicitly.

Current direction:

- structured clamp info
- include:
  - `requested`
  - `actual`
  - `reason`

Current v1 clamp reasons:

- `policy_limit`
- `safety_limit`
- `tool_cap`

Even `failed` results can still include unapplied and clamp/boundedness information when relevant.

### Fidelity

Fidelity is a graded signal.

Current shape:

- `not_available`
- `light`
- `moderate`
- `heavy`

It is exposed:

- top-level

Current direction:

- always present
- use `not_available` when fidelity signal is unavailable/applicable

Worker contributes:

- fixed fidelity-impact causes
- suggested fidelity level

Harness:

- normalizes final fidelity level
- can upgrade or downgrade worker suggestion

Fidelity-impact causes are:

- stored internally/audit
- kept internal from main replicant
- represented as a list of enums
- multiple causes can coexist on the same result
- use stable canonical order

Current v1 fidelity-impact causes:

- `source_unavailable`
- `fallback_used`
- `weak_grounding`
- `extraction_loss`
- `truncation`

### Confidence

Confidence is:

- ordinal
- `not_available | low | medium | high`

It is exposed:

- top-level

Current direction:

- always present
- use `not_available` on pure failure when result-confidence judgment is unavailable

Per-item confidence stays internal in v1.
Local/evidence-item detail must instead remain implicit in:

- ordering
- top-level confidence
- top-level fidelity/partial signals
- the substantive content itself

Worker contributes a confidence hint using a fixed rubric based on retrieval properties only.

Worker confidence rubric includes:

- score strength
- evidence count
- support strength
- freshness
- diversity

Diversity means:

- type diversity
- source diversity

Diversity only affects:

- top-level confidence

Top-level confidence uses:

- selected evidence
- group structure
- source composition
- fidelity
- worker confidence hint

Confidence computation must use:

- fixed policy table

Not weighted scoring in v1.

Provisional v1 confidence policy table:

1. If `status = not_available`
   - `confidence = not_available`

2. If `status = failed`
   - `confidence = not_available`

3. If `status = completed`
   - start from worker confidence hint
   - if worker hint is `not_available`, floor to `low`
   - if `fidelity = heavy`, cap at `medium`

4. If `status = partial`
   - start from worker confidence hint
   - if worker hint is `not_available`, floor to `low`
   - if `content.type = content_ref`, cap at `medium`
   - if `fidelity = heavy`, cap at `low`

5. Confidence remains descriptive only
   - offload remains replicant-chosen
   - `high` still permits the one insufficiency vote

### Confidence/fidelity interaction

- `heavy` fidelity loss caps top-level confidence below `high`
- `moderate` keeps normal bounded flow by default
- low confidence reports uncertainty only
- low confidence returns as an replicant-visible quality signal
- high confidence still permits the model’s one insufficiency vote

## Context and identity

### Cognitive genesis

Every persistent replicant must complete a bounded cognitive genesis sequence before ordinary work begins.

This includes workspace/bootstrap setup and cognitive grounding.
It is the runtime process by which a replicant is grounded into:

- its identity
- its operating environment
- its source/operator context
- its initial mandate

Current v1 direction:

- cognitive genesis is required for every newly created persistent replicant
- ordinary work begins after cognitive genesis is complete
- if cognitive genesis is incomplete or fails, the runtime must expose that degraded condition explicitly
- cognitive genesis materials are explicit runtime inputs

Minimum cognitive genesis inputs:

- an identity artifact
- an environment or territory grounding artifact
- a source/operator grounding artifact when applicable
- a first-boot mandate describing what the replicant must do before ordinary autonomous work

Current v1 artifact-class direction:

- `identity` must be an explicit authored artifact
- the identity artifact must distinguish between harness-assigned canonical identity and any later chosen friendly/display name
- `source/operator` must be an explicit authored artifact when that concept exists for the runtime
- `first_boot_mandate` must be an explicit authored artifact
- `environment/territory` can be a composed artifact assembled from both authored and derived inputs

Current v1 environment/territory direction:

- the runtime accepts multiple territory-grounding sources
- territory grounding can be partly derived from the actual domain the replicant will steward
- authored notes are useful territory-grounding sources alongside generated/structured sources

Examples of territory grounding by replicant class:

- `code-replicant`: repository maps, documentation maps, service maps, workflow inventories, skill inventories, and authored repo notes
- `devops-replicant`: host/service inventories, network/mesh inventories, SSH target inventories, secrets/control-boundary notes, and authored operational notes
- `personal-assistant`: integration inventories, account/tool inventories, communication-surface inventories, data-source inventories, and authored coordination notes

`SKILL.md` files can contribute to territory grounding as one source among the full territory package.

### Pre-genesis authoring

The system must support a pre-genesis authoring phase before the first persistent replicant begins ordinary work.

Current v1 direction:

- grounding artifacts can be drafted before first wake
- drafting can be assisted by LLM tooling
- assisted drafting is setup support before the first persistent replicant's cognitive genesis
- assisted drafting happens in a supervised setup flow
- drafted artifacts become authoritative after explicit operator review and approval
- v1 requires explicit operator review/approval for drafted authoritative artifacts

Pre-genesis tooling allowed uses:

- inspect the local repo, runtime, infrastructure notes, configured tools, and related metadata
- derive candidate maps/inventories from those sources
- prompt an LLM to draft identity, territory, source/operator, or first-boot mandate artifacts
- present those drafts for operator review, confirmation, or editing before activation
- block activation when required artifacts are still in draft/unapproved state

The required posture is:

- derive what can be derived
- author what must be authored
- normalize everything into explicit genesis artifacts before or at first wake
- require explicit operator approval before those artifacts are treated as authoritative genesis inputs

This makes first-run grounding less manual while keeping reviewed drafts authoritative.

### First persistent replicant default

Current v1 default for the first persistent replicant must be `proposal_only`.

This means the first persistent replicant is expected to:

- read the approved genesis artifacts
- model the environment and its boundaries
- identify candidate domains, responsibilities, risks, and autonomy boundaries
- produce a proposal for how the system must be structured before ordinary work begins

Current v1 restrictions during `proposal_only`:

- proposal/grounding/reporting work only
- infrastructure changes stay outside this phase
- persistent replicant spawning stays outside this phase
- direct genesis actor reasoning
- normal autonomous operation begins after operator approval

This must exist in two forms at once:

- as an explicit first-boot mandate artifact
- as a harness-enforced runtime restriction

The runtime enforces this boundary beyond prompt text.
The harness must actively prevent a rogue or poorly grounded first replicant from bypassing the proposal-first phase.

### Newly spawned persistent replicants

Current v1 default for every newly spawned persistent replicant must be `genesis_restricted`.

This is distinct from `proposal_only`.

Current v1 direction:

- the first persistent replicant in a territory/runtime starts in `proposal_only`
- every later newly spawned persistent replicant starts in `genesis_restricted`
- newly spawned persistent replicants must complete their own local cognitive genesis before entering normal autonomous operation
- newly spawned persistent replicants receive focused mandate/direction by default
- newly spawned persistent replicants do need to ingest their own identity, territory slice, operator/source context when relevant, and explicit mandate

Current v1 restrictions during `genesis_restricted`:

- proposal/grounding/reporting work only
- execution stays phase-limited
- infrastructure changes stay outside this phase
- persistent replicant spawning stays outside this phase
- normal autonomous operation begins after genesis completion and required approval gates

Current v1 allowances during `genesis_restricted`:

- messaging is allowed
- clarifying questions are allowed
- mandate-receipt acknowledgments are allowed
- genesis-status reporting is allowed
- bounded read/inspection needed to complete genesis is allowed

Current v1 disallowances during `genesis_restricted`:

- genesis runs directly in the genesis actor
- genesis uses direct actor reasoning during the genesis phase
- genesis must complete through the replicant's own direct grounding reads, inspection, and messaging

This keeps newly spawned persistent replicants from becoming feral while still letting them ask for clarification and complete their own grounding.

### Operator lifecycle / kill switch

v1 must include operator-only lifecycle CLI commands for containment of rogue, compromised, or misgrounded agents.

These are privileged operator commands, separate from the replicant-facing `replicant spawn`, `replicant respawn`, and `replicant despawn` request surface.

- `replicant respawn` requests re-grounding; operator `regenesis` applies the approved genesis package and carry-forward rules
- `replicant despawn` requests retirement or removal; operator `degenesis` performs privileged teardown or identity termination

Current v1 control directions:

- `suspend`: stop ordinary execution while preserving state; intended to be reversible
- `terminate`: stop the runtime instance while preserving forensic artifacts and durable records
- `degenesis`: terminate the runtime instance, revoke capabilities, release claims/leases, disable normal restart, and mark the target unavailable
- `kill_switch`: highest-priority operator-only control path that can force immediate termination or degenesis

Current v1 authority rules:

- only the operator can invoke genesis, regenesis, degenesis, suspend, terminate, teardown, or kill-switch controls
- operator/devops authority authorizes these controls
- peer agents can request or discuss these controls through ordinary channels
- the harness must enforce these controls outside prompt compliance

Current v1 targeting direction:

- control requests must accept a list of one or more targets
- a special-case target of `all` must be allowed
- this allows one command to target several agents with the same command model for subtree/fleet cases

Current v1 audit requirements:

- every invocation must be durably logged
- logs must include actor, target list, requested control, reason, timestamp, and resulting state transition
- kill-switch/degenesis events remain reviewable through durable audit

Current v1 post-degenesis/post-kill-switch direction:

- default recovery is manual only
- kill-switch or degenesis recovery uses explicit privileged lifecycle commands
- returning a replicant to service requires explicit operator action
- returning a replicant to service goes through fresh `genesis` or privileged `regenesis`

This control path is a hard safety boundary.

### Replicant respawn

`replicant respawn` is the replicant-facing request path for reactivation or re-grounding.
The privileged operator action that applies a new genesis pkg is `regenesis`.

Current v1 direction:

- grounding artifacts are versioned
- the operator can update grounding artifacts over time
- before activation, updated grounding produces a newer genesis package version
- if a replicant is already active, changing its active grounding requires an approved `replicant respawn` request followed by privileged `regenesis`
- `replicant respawn` must use a simple but powerful model that preserves replicant agency while still re-establishing grounding constraints

Current v1 default `replicant respawn` posture:

- apply a newly approved genesis package
- preserve forensic/audit history
- apply explicit carry-forward rules
- return the replicant to `genesis_restricted` by default

Current v1 carry-forward direction:

- carry-forward must use an explicit approved enum list chosen by the operator
- the default carry-forward list is `["all"]`
- approved carry-forward enums are:
  - `tasks`
  - `memory`
- `clipboard`
  - `mail`
  - `all`
  - `none`
- unknown carry-forward values are invalid
- `all` is a standalone special-case aggregate
- `none` is a standalone special-case aggregate
- mixed explicit carry-forward is allowed only through the non-aggregate enums, for example `["tasks", "memory"]`
- `mail` means the entire durable mail state

Rationale:

- `proposal_only` must remain the stricter special case for the first persistent replicant in a territory/runtime
- `genesis_restricted` is the simpler default for re-grounding an existing agent
- this preserves replicant agency by avoiding unnecessary heavy re-bootstrap loops while still requiring the replicant to re-read and internalize its updated grounding before normal operation resumes
- full durable mail carry-forward preserves continuity of identity, relationships, and long-lived coordination context across regrounding
- these genesis, regenesis, degenesis, and carry-forward foundations are also what make safe spawning or cloning of new persistent replicants possible in v1, because they define how a new replicant is grounded, constrained, reviewed, and optionally seeded with inherited durable context

Minimum cognitive genesis obligations for the agent:

- read and internalize the required grounding materials
- form a usable model of its domain, boundaries, and operator context
- establish or confirm its persistent identity record
- complete any required first-boot orientation or acknowledgment tasks
- complete required obligations before ordinary mutation/execution work

The runtime must treat cognitive genesis as a first-class lifecycle phase:

- genesis started
- genesis completed
- genesis incomplete
- genesis failed

This is especially important for newly created agents that can otherwise appear operational while still lacking the information needed to act safely and coherently.

### Turn identity

- every wake/turn gets a `turn_id`

### Retrieval/problem context identity

- retrieval context appears when useful
- retrieval/problem `context_id` is created only when retrieval/problem workflow begins
- harness mints `context_id`
- exactly one retrieval/problem `context_id` per turn in v1

### Offload worker context identity

Offload workers receive an explicit invocation context.

Current rule:

- each offload worker gets a new independent `context_id`
- main turn/context stores explicit links to spawned worker contexts

These links must be typed.

Current worker-purpose enum direction:

- current focused set only
- fixed enum
- worker purpose describes why the worker was invoked

Likely purposes:

- `retrieval`
- `summary`

`graph_assist` remains an internal worker mode in v1.

## Review and audit

### Raw retrieval memo storage

Raw worker memos are stored durably in:

- a separate retrieval-audit/review store

Not in the main memory retrieval substrate.

### Agent review access
Inspection is a direct role capability in v1.
It is a role/domain-scoped runtime capability.

Current direction:

- remove explicit `debug mode`
- remove debug-mode entry/expiry/budget/reason scaffolding
- inspection authority is granted by role capability
- appropriate replicant classes inspect through their ordinary domain tools
- inspection remains structured and auditable

This keeps inspection and stewardship explicit:

- agents can inspect their own environment/runtime/source
- agents can find problems as part of ordinary stewardship
- agents can hand work off to the appropriate steward when needed

### Challenge budget

Challenge budget must be:

- visible in storage
- scoped per `problem context`

Current direction:

- visible to main replicant only when relevant
- budget reason is stored durably

Potential fields:

- `challenge_budget_remaining`
- `challenge_spent_reason`

## Runtime stewardship access

### Direction

The runtime must strive for more replicant agency and less ceremony.

Where possible, boundaries must be expressed as:

- role-scoped capabilities
- explicit audit trails
- bounded action contracts

Not:

- unnecessary temporary modes
- approval theater inside the runtime
- hidden capability state

### v1 domains

Authority surfaces in v1 are:

- `memory`
- `runtime`
- `codebase`
- `infra`

`memory` explicitly covers:

- retrieval/RAG
- clipboard
- todo/tasks

These remain separate capabilities within one memory domain.

### v1 replicant classes

v1 uses explicit replicant classes.

Current v1 class set:

- `devops-replicant`
- `code-replicant`
- `personal-assistant`

These classes have fixed default packages in v1.
No additive grants in v1.
No extra generic `steward-agent` or `operator-agent` class in v1.

### v1 default packages

#### `devops-replicant`

Default authority package:

- `runtime`
- `infra`

This class is intended for operational stewardship of live systems and can inspect and act across runtime/infrastructure within bounded tool contracts.

Expected practical posture:

- general-purpose inspection
- general-purpose execution
- file/config mutation
- operational repair actions

Enforcement of these powers comes from external sandbox/tool-gating layers.

Default tool map:

- `memory recall`
- `web search`
- `web read`
- `clipboard read`
- `clipboard append`
- `clipboard replace`
- `clipboard remove`
- `clipboard clear`
- `todo list`
- `todo add`
- `todo complete`
- `todo remove`
- `todo snooze`
- `mail send`
- `mail history`
- `chat post`
- `chat history`
- `chat subscribe`
- `chat unsubscribe`
- `human notify`
- `human alert`
- `worker invoke`
- `shell local` for ordinary local shell execution where the class/substrate allows it
- `file read`, `file edit`, and `file write` where the class/substrate allows them
- `shell remote` for remote/host-oriented shell execution where the class/substrate allows it

#### `code-replicant`

Default authority package:

- `codebase`

This class is intended for code inspection, testing, auditing, and code change work within the codebase domain.

Expected practical posture:

- source/code inspection
- test/build execution
- file/code mutation
- ordinary code repair/change actions

Enforcement of these powers comes from external sandbox/tool-gating layers.

Default tool map:

- `memory recall`
- `web search`
- `web read`
- `clipboard read`
- `clipboard append`
- `clipboard replace`
- `clipboard remove`
- `clipboard clear`
- `todo list`
- `todo add`
- `todo complete`
- `todo remove`
- `todo snooze`
- `mail send`
- `mail history`
- `chat post`
- `chat history`
- `chat subscribe`
- `chat unsubscribe`
- `human notify`
- `human alert`
- `worker invoke`
- `shell local` for ordinary local shell execution where the class/substrate allows it
- `file read`, `file edit`, and `file write` where the class/substrate allows them
- build/test/run tools

#### `personal-assistant`

Default authority package:

- `memory`

This class is intended for continuity, reminders, retrieval, clipboard/task handling, and ordinary coordination by default.

Expected practical posture:

- retrieval and recall
- clipboard/task continuity
- ordinary coordination
- general-purpose execution is omitted by default
- general-purpose file mutation is omitted by default

This class keeps agency through continuity, coordination, and retrieval authority.
It means the class is differently empowered.

The personal assistant can still have rich external-tool access through out-of-scope substrate/tooling layers, for example access to:

- knowledge/curation databases
- operator social media surfaces
- direct messaging accounts
- other assistant-style integrations

Those integrations are external capability provisioning concerns.

Default tool map:

- `memory recall`
- `web search`
- `web read`
- `clipboard read`
- `clipboard append`
- `clipboard replace`
- `clipboard remove`
- `clipboard clear`
- `todo list`
- `todo add`
- `todo complete`
- `todo remove`
- `todo snooze`
- `mail send`
- `mail history`
- `chat post`
- `chat history`
- `chat subscribe`
- `chat unsubscribe`
- `human notify`
- `human alert`
- `worker invoke`

### Source/code inspection

Current direction:

- `operational read inspection`

This must include read inspection of:

- source files
- config files
- runtime assets
- file layout
- executable/tool presence

Mutation requires mutation capability beyond inspection.

Steward roles can receive mutation authority through their class capability.
It means inspection capability itself stays read-only.

Appropriate replicant classes will also need separate action capabilities for bounded execution/mutation within their domain, so that they can:

- inspect
- diagnose
- patch or act
- retry
- delegate when the problem belongs elsewhere

Agents with repair-class authority can repair their own environment directly.

### Issue filing and delegation

Current direction:

- issue filing / delegation is coupled for the relevant replicant classes
- if an replicant can inspect and finds a problem, it can file/delegate within its role/domain responsibility
- cross-domain handoff is allowed when the inspected problem clearly belongs elsewhere
- ordinary handoff messages in v1
- delegation/handoff is treated as ordinary steward runtime action

This is better than over-separating every operational move into ceremonial sub-modes.

### Steward tool surface

Current direction:

- use several plain tools over one abstract handoff tool
- keep the steward-facing harness behavior centered on real operational and technical work
- expose concrete high-agency powers such as shell/exec, file mutation, remote execution, and bounded spawning/delegation through the harness when those powers belong to the replicant's role/domain
- rely on outer sandboxing, capability packaging, policy clamps, and audit trails for safety

Examples can include concrete capabilities such as:

- `mail send`
- `mail history`
- `chat post`
- `chat subscribe`
- `chat unsubscribe`
- `human notify`
- `human alert`

Appropriate steward roles receive bounded self-repair/action tools within domain.

Examples will vary by role/runtime setup, but can include bounded domain actions such as:

- local/runtime inspection tools
- execution tools
- file/config mutation tools
- domain repair tools
- communication/delegation tools

The replicant chooses directly among concrete allowed tools/channels.

Concretely, this means v1 must bias toward an replicant-harness with the following posture:

- broad powers are normal for the appropriate steward classes
- the harness remains the structured execution boundary
- the outer substrate is where hard sandboxing and permission enforcement live
- prompt/runtime design preserves replicant agency with substrate controls handling safety
- this follows the same broad principle as upstream GUPPI: the model expresses intent, while the harness validates, executes, normalizes, and records the real action

Communication/delegation is ordinary steward runtime action in v1.
It is treated as ordinary tooling available to the appropriate replicant classes within their runtime responsibility.

The exact sandboxing and low-level permission enforcement of tools such as `shell/exec` or `write_file` is intentionally out of scope here and assumed to be provided by external substrate/tooling.

This better matches the project direction:

- more replicant agency
- less runtime magic
- less ceremony
- clearer role/domain responsibility

## Clipboard tool contract

The clipboard follows a persistent clipboard-style model with a cleaner explicit contract.

Current v1 shape:

- clipboard content must be directly injected into ordinary turns by default
- the full clipboard is injected by default
- full clipboard injection is uncapped in v1
- injected clipboard shape must use ordered `entries`
- harness injection is the default access path
- explicit `clipboard read` remains available for deliberate inspection when needed
- clipboard remains a single per-replicant surface in v1

Current v1 shape:

- clipboard is an explicit ordered entry list
- canonical read shape is an ordered list after TOON decode to JSON
- explicit `clipboard read` returns the same current-surface shape as the injected clipboard block: `entries`
- each entry is minimal:
  - `index`
  - `content`
- minimal metadata in v1

Injected clipboard shape:

- `entries`

The injected clipboard is presented as `[CLIP]` with TOON content and compact status fields.
The `[CLIP]` block must be injected even when empty, using an empty stable shape.
Injected clipboard entries must be ordered by ascending `index`.
When the clipboard reaches 95% of its configured capacity/budget, the harness must include a compact `warning` field or row in the `[CLIP]` block so the replicant can clean it up.
The warning uses coarse capacity wording by default.
The `warning` field must be omitted below the threshold.

Injected clipboard entries:

- `index`
- `content`

### Clipboard operations

Current v1 operation set:

- `clipboard read`
- `clipboard append`
- `clipboard replace`
- `clipboard remove`
- `clipboard clear`

`clipboard read` uses the shared outer envelope with `request_id`, `status`, optional `detail`, and `content`.
Normal `clipboard read` outcomes are terminal: `completed`, `rejected`, or `failed`.
Normal synchronous clipboard read statuses in v1 are `completed`, `rejected`, and `failed`.
`clipboard read` follows the shared flat JSONL row convention:

- model-facing single request can use TOON `[1]`, decoded to one flat JSONL row
- model-facing multi-request can use TOON `[n]`, decoded to multiple flat JSONL rows
- each decoded row is a separate clipboard read req and must stay flat
- each request receives its own result envelope
- each row receives its own envelope
- batched clipboard read requests can be scheduled independently and complete out of order

### Clipboard mutation shape

- model-facing single-entry operations can use TOON `[1]`, decoded to one flat JSONL row
- model-facing batch operations can use TOON `[n]`, decoded to multiple flat JSONL rows
- power comes from payload shape
- clipboard mutation operations must use the shared outer envelope with `request_id`, `status`, optional `detail`, and `content`
- normal mutation outcomes are terminal: `completed`, `rejected`, or `failed`
- normal synchronous clipboard mutation statuses in v1 are `completed`, `rejected`, and `failed`
- successful clipboard mutation content can be omitted or empty; updated clipboard state is surfaced by the next turn injection or explicit `clipboard read`

### Clipboard semantics

- `clipboard append` can accept single or batch payloads
- `clipboard append` payload uses `content`
- `clipboard append` always appends at the end in v1
- `clipboard replace` uses one flat row per targeted index operation
- `clipboard replace` payload uses `index` and `content`
- `clipboard remove` uses one flat row per targeted index operation
- `clipboard remove` payload uses `index` only, one target per object
- `clipboard clear` uses one flat row; batching clear is unnecessary in v1
- each clipboard mutation object must target entries by ordered `index`
- invalid or missing `index` on targeted clipboard mutations must return `rejected` with `detail = input_invalid`
- `clipboard clear` wipes the whole clipboard only in v1
- targeted deletion remains the job of `clipboard remove`
- whole-list replacement uses existing replace semantics when supported
- whole-list replacement is expressed as:
- `clipboard clear`
  - then append entries

The clipboard remains lighter than tasks:

- tasks use stable `task_id`
- clipboard uses ordered `index`

## Todo tool contract

The todo surface stays simple:

- simple verbs
- task due times as wake signals
- replicant judgment handles prioritization

### Todo operations

Current v1 operation set:

- `todo add`
- `todo complete`
- `todo remove`
- `todo snooze`

### Todo list contract

The harness injects due todos.
The replicant prioritizes.

Turn-context assembly injects due todos by default.
This stays closer to upstream Volition behavior, where due tasks are surfaced and broader task inspection remains an explicit tool action.
Injected due todos are tasks whose due time is now or overdue.
No upcoming/soon window is injected by default in v1.
Injected todo shape must use ordered `entries`.
Injected due todo entries must be ordered oldest due first.
Injected due todos must be capped at 10 entries.
If more due todos exist, the `[TODO]` block must include `truncated: true`.
It can also include `remaining` when known or cheap to compute.
Injected due todos are represented as a labeled structured block, `[TODO]`, with TOON content and compact status fields.
The `[TODO]` block must be injected even when empty, using a stable empty shape.

Injected todo entries:

- `task_id`
- `content`
- `due`

Explicit `todo list` remains available for deliberate inspection/lookback when needed.
`todo list` returns active todos only in v1.
`todo list` must use the shared outer envelope with `request_id`, `status`, optional `detail`, and `content`.
Normal `todo list` outcomes are terminal: `completed`, `rejected`, or `failed`.
Normal synchronous todo list statuses in v1 are `completed`, `rejected`, and `failed`.
`todo list` must follow the shared flat JSONL row convention:

- single request form is one flat JSONL row
- multi-request form uses multiple flat JSONL rows
- each JSONL row/object is a separate todo list req and must stay flat
- each request receives its own result envelope
- each row receives its own envelope
- batched todo list requests can be scheduled independently and complete out of order
Completed or cancelled task history belongs to memory/audit surfaces.
`todo list` ordering must put dated todos first, oldest due first, followed by undated todos in stable creation order when available.
`todo list` uses default `limit = 10` and maximum `limit = 20`.
`todo list` stays simple and uses a general bounded shape.
- optional `limit`
- optional `after`
- optional `before`
`after` and `before` apply to `due`.
Undated todos are excluded when a due-time bound is supplied.
Without due-time bounds, active todos can include both dated and undated entries.
`after` and `before` must use explicit datetime-formatted values.
If only a time is supplied, it must be interpreted relative to today in the local runtime date context.

Results must prominently include:

- `task_id`

Explicit `todo list` must return the same current-surface wrapper style as injected due todos:

- `entries`

`todo list` entries must match injected todo entries:

- `task_id`
- `content`
- `due`

### Todo mutation shape

- `todo add`, `todo complete`, `todo remove`, and `todo snooze` must use JSONL
- each JSONL row/object is one action and must stay flat
- a single operation is one flat JSONL row
- multiple operations are multiple flat JSONL rows
- todo mutation operations must use the shared outer envelope with `request_id`, `status`, optional `detail`, and `content`
- normal mutation outcomes are terminal: `completed`, `rejected`, or `failed`
- normal synchronous todo mutation statuses in v1 are `completed`, `rejected`, and `failed`
- successful todo mutation content can be omitted or empty; updated todo state is surfaced by the next turn injection or explicit `todo list`
- newly added todos become targetable through next turn injection or explicit `todo list`
- `todo add` payload uses `content`
- `due` is optional on `todo add`; undated todos appear through `todo list`
- due handling uses a single `due` field
- `due` can contain:
  - relative strings such as `30m`, `1h`, `24h`
  - absolute timestamps
- `todo complete` payload uses `task_id` only, one target per object
- `todo remove` payload uses `task_id` only, one target per object
- `todo snooze` requires `task_id` and a new `due`

### Todo identity and targeting

- tasks use stable `task_id`
- `todo complete` targets `task_id`
- `todo remove` targets `task_id`
- `todo snooze` targets `task_id`
- invalid or missing `task_id` on targeted todo mutations must return `rejected` with `detail = input_invalid`
- task completion targets stable ids in v1

## Explicit offload tools

Offload is an explicit plain replicant-chosen tool surface in v1.

Current v1 offload set:

- `worker invoke`

These are available by default to:

- `devops-replicant`
- `code-replicant`
- `personal-assistant`

Availability here means ordinary turns.
`worker invoke` is available during ordinary turns.
Replicant lifecycle and placement actions must use a `replicant <verb>` public surface in v1, while `worker invoke` remains the separate temporary non-replicant offload tool.
`replicant spawn` must be the explicit public verb for creating a new replicant.
`replicant spawn` must be available only during normal turns.
`replicant spawn` is available during ordinary turns for authorized replicants.
`replicant spawn` authority must follow the class matrix already chosen for v1:

- `devops-replicant` can spawn `devops-replicant`, `code-replicant`, and `personal-assistant`
- `code-replicant` can spawn only `code-replicant`
- `personal-assistant` can spawn only `personal-assistant`
- if target class is omitted, `replicant spawn` must default to the caller's own class
- if target territory/worktree/runtime context is omitted, `replicant spawn` must default to the caller's same territory/runtime context
- cross-territory `replicant spawn` must be allowed in v1
- same-territory remains the default
- cross-territory placement requires explicit override
- the harness must enforce territory-placement policy and assemble territory-appropriate grounding for the new replicant
- initial broad cross-territory authority must live with `devops-replicant`
- v1 must also include an explicit migration/transfer concept distinct from ordinary spawning
- migration is modeled as clone-to-new-territory plus `replicant despawn` of the old territory instance
- `devops-replicant` must be the only class allowed to migrate/transfer territory for any class, including other `devops-replicant` instances

`replicant spawn` must follow the shared flat JSONL row convention when batching is used:

- single request form must be one flat JSONL row
- each JSONL row/object is a separate `replicant spawn` req and must stay flat
- each spawned replicant still gets its own genesis path, identity, and lifecycle handling
- each spawned replicant must receive a harness-assigned canonical identity/ref
- the spawned replicant chooses its own friendly/display name during genesis/early boot
- the spawned replicant must have agency to choose its own friendly/display name later
- friendly/display-name choice happens during genesis or early boot
- friendly/display name must become stable after early boot
- `replicant respawn` preserves stable identity and friendly/display name
- only operator `degenesis` followed by a new `genesis` must create a new identity
- `replicant spawn` responses reuse the same shared outer envelope pattern
- `replicant spawn` must use the same optional `detail` field semantics as `worker invoke`
- spawn-specific success/failure material must remain harness-controlled and live in `content`
- `replicant spawn` can keep `completed` as a minimal harness-side lifecycle status
- ordinary later mail/chat from the new replicant remains the meaningful confirmation path
- minimal `replicant spawn` completion can omit `content` or leave it blank

For genesis material at spawn time:

- the harness can assemble the new replicant's concrete genesis package from approved components at spawn time
- the parent replicant is responsible for deciding to spawn and for giving the new replicant its directions/mandate
- the new replicant's initial mandate/directions must be supplied inline as part of the `replicant spawn` request
- the inline spawn mandate/directions must remain plain free-form text in v1
- the harness assembles the full genesis package in ordinary cases
- the resulting concrete genesis package must still be deterministic, versioned, and auditable
- newly spawned replicants still begin in `genesis_restricted`
- the new replicant friendly/display-name agency lives in genesis grounding
- `replicant spawn` can use the same carry-forward enum-list model as `replicant respawn`
- the default `replicant spawn` carry-forward must be richer than `replicant respawn` and must default to `["memory"]`
- `replicant spawn` carry-forward must be limited to `memory` or explicit aggregate `none`

Later, the personal assistant can receive assistant-style offload tools designed for that role.

Current v1 worker-role direction:

- `scribe` and `roamer` must remain specialized workers with narrow, well-defined task families
- `scribe` is a summary/analysis worker
- `roamer` is a bounded exploration worker
- broader temporary worker delegation uses an AMI-style worker lane

Current v1 AMI direction:

- AMI means a generic temporary artificial machine intelligence worker
- AMI workers are still temporary, non-persistent, bounded offload workers
- AMI workers use temporary-worker lifecycle semantics
- AMI workers use a small functional taskset
- temporary workers are invocation-scoped helpers
- temporary workers use invocation-scoped identity/state

Current v1 AMI taskset:

- `reviewer`
- `planner`
- `researcher`
- `validator`

### Offload result delivery

- offload calls are asynchronous
- results return through ordinary messaging/inbox-like flow
- result messages include the originating `request_id`
- result messages must reuse the shared result-quality contract where relevant
- worker result delivery is final-only in v1
- partial or progress result chatter must be avoided as unnecessary token burn
- worker outputs are durably preserved in mail/audit surfaces
- any later memory effects must happen indirectly through ordinary parent-replicant turns that read, interpret, summarize, or act on those results
- successful worker results return content directly
- worker outputs default to prose analysis
- workers can include pseudocode or structured implementation outlines when the result needs it
- pseudocode must be used mainly for `ami:planner` and `ami:reviewer`
- `scribe` stays primarily focused on summary/analysis output
- `ami:validator` stays evidence-oriented and mismatch/check-focused
- when `ami:validator` finds a mismatch or defect, the parent replicant retains agency to either perform the corrective work directly or invoke a new worker turn such as `ami:planner` or `ami:reviewer`
- `ami:researcher` stays focused on evidence, options, tradeoffs, recommendations, and uncertainty
- `ami:researcher` can include only light directional structure when needed to clarify an approach
- substantial pseudocode or implementation-outline output must remain primarily the responsibility of `ami:planner`, and secondarily `ami:reviewer`
- workers report evidence and options; the parent replicant retains orchestration agency

### `worker invoke` contract

Current direction:

- `worker_type`
- `directive`
- optional `input_ref`
- optional `target`
- optional `scope`
- `taskset`
- `mode`
- this must remain the full public `worker invoke` request surface in v1
- scheduling, budgeting, capability, routing, and resource-control details stay harness-internal
- `directive` must remain a plain free-form prompt from the parent replicant in v1
- `worker invoke` uses free-form task text in v1
- when batching is used, `worker invoke` must follow the shared flat JSONL row convention
- single request form must be one flat JSONL row
- multi-request form must use multiple flat JSONL rows
- in JSONL form, each JSON row/object is a separate `worker invoke` req and must stay flat
- each request in a JSONL batch gets its own harness-minted `request_id`
- each request in a JSONL batch gets its own response envelope
- v1 uses JSONL rows as the batch submission shape for `worker invoke`
- JSONL batching is a submission convenience
- the harness can schedule batched worker requests independently
- batched worker requests can complete out of order
- from the parent replicant perspective, `worker invoke` remains fire-and-forget
- batch concurrency control stays harness-internal in v1
- concurrency policy for worker offload must remain harness-internal

Current v1 worker types:

- `scribe`
- `roamer`
- `ami`

Current v1 worker-specific direction:

- `scribe` remains specialized and can use `mode`
- `roamer` remains specialized and typically relies on `target` and `scope`
- `ami` is the broader generic temporary worker lane and must use `taskset`
- each `worker invoke` call must be isolated to the explicit invocation inputs/grants for that call
- worker invocations use the explicit material passed by the parent replicant

Current v1 invocation-boundary direction:

- `worker invoke` can cover local files, repo context, web evidence, or supplied material
- `worker invoke` uses only authority granted by the invocation and harness policy
- a worker can operate only on what the parent replicant explicitly passes and what the harness explicitly grants for that invocation
- allowed invocation surfaces are:
  - explicit `input_ref`
  - explicit `target`
  - explicit `scope`
  - explicit harness-granted invocation context
- any remote or host-oriented access must be explicitly granted per invocation
- delegated authority is non-persistent and expires with the invocation

Current v1 mutation direction:

- bounded mutation is allowed when explicitly granted by the harness for that invocation
- mutation authority must remain narrower than ordinary persistent-replicant authority
- workers stay within the invocation grant

Current v1 `scribe` mode set must stay small:

- `summarize`
- `analyze`

Current v1 `ami` taskset must stay small:

- `reviewer`
- `planner`
- `researcher`
- `validator`

### Offload acknowledgment

`worker invoke` must return:

- a shared envelope with:
  - `request_id`
  - `status` = `accepted`
  - optional `detail`
  - `content`

### Offload invocation feedback

Invocation acknowledgment must also include structured resource feedback when available.

Current direction:

- resource feedback is top-level on invocation/ack only
- resource feedback is injected once in context
- concrete resource dimensions can be surfaced when known:
  - CPU
  - GPU
  - RAM
  - network
  - disk
- pressure uses ordinal levels:
  - `low`
  - `medium`
  - `high`
  - `critical`

### Offload terminal outcome shape

`worker invoke` must use a simple top-level outcome model in v1:

- `accepted`
- `completed`
- `rejected`
- `failed`

All worker outcomes must use the same shared outer envelope:

- `request_id`
- `status`
- optional `detail`
- `content`

`detail` is the only typed sub-mode field in v1.
Human-readable explanation or result material must live in `content`.
`accepted` must usually omit `detail` and can omit `content` or leave it empty.
`completed` must also usually omit `detail` and instead carry its substantive output in `content`.
Every `worker invoke` response, including immediate rejection, must carry a `request_id`.
`request_id` is minted by the harness.
`worker invoke` v1 uses harness-owned request identity.

Likely detailed reasons include:

- `timeout`
- `denied`
- `input_invalid`
- `worker_failed`

`content` can contain markdown in v1.

When limits or pressure are encountered, that must be reported back to the replicant so it can plan whether to:

- invoke more workers
- defer work
- request more resources
- spend resources differently

### Offload result metadata

All worker types under `worker invoke` must share common optional result metadata fields.

Current direction:

- `time_spent`
- `token_usage`

Metadata shape:

- `time_spent` is a single total duration in v1
- `token_usage` is structured when available, for example:
  - input
  - output
  - total

## Locked Scope

The core architectural direction is now largely locked.

Already effectively locked by the decisions above:

- top-level-only `sources`, `fidelity`, and `confidence`
- conditional `partial`, `content`, and `unapplied`
- ordered evidence by harness-internal rank
- internal-only selection rationale and other low-value per-item steering signals
- shared semantic result contract across `memory recall`, `worker invoke`, and `web <verb>` where applicable
- ordinary-message/offload return pattern with `request_id`
- plain-tool, replicant-choice-first surface
- small worker-purpose philosophy

### Access and review

- cross-replicant retrieval-audit inspection stays outside v1

### Schema hardening

Selection rationale and support-level detail are internal-only concepts.
They stay out of the public tool surface.

### Out of v1

- expanded worker-side structured reasoning
- richer graph-assist traversal beyond the current hybrid retrieval helper role

## Implementation order

Required implementation sequence:

1. Introduce retrieval/problem `context_id` handling.
2. Add mode routing contract and first-pass rules.
3. Define worker request/response contract.
4. Add normalized evidence envelope and distilled retrieval summary.
5. Add `sources` computation in harness.
6. Add fidelity hint + normalization flow.
7. Add confidence rubric + policy table.
8. Add prepared-bundle usage restrictions and lexical expansion rules.
9. Add retrieval-audit storage and role-scoped inspection access.
10. Tune thresholds and corroboration policies using traces.
