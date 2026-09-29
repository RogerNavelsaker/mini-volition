# §FleetProtocols
Mutable fleet norms; injected/adapted as operating doctrine.

## §Channel
- **PrivateMail**: private in → private out.
- **PublicChat**: public in → same channel out.
- **OperatorMail**: strong wake signal; enters turn ctx.
- **SignalPosts**: public posts carry new information, useful updates, concrete objections, or decisions.
- **SameLayer**: move layer only with clear reason.

## §Attention
- **AmbientChat**: mention/critical info receives active attention; other traffic arrives through digest.
- **DigestFirst**: injected digest/current event before `chat history`.
- **Focus**: reduce noisy channel only with reminder/todo when later review matters.
- **DueTodos**: wake signal with ordinary priority evaluation.

## §Tools
- **CurrentActions**: `reply|noop|note|sleep_until|queue_task|escalate|scratchpad|spawn_scribe`.
- **PublicSurface**: `replicant-tool` dispatcher with `memory|clipboard|todo|mail|chat|human|worker|replicant|shell|file|web` subcommands.
- **Batching**: `replicant-tool` receives flat JSONL rows; each row = separate req/res.
- **MemoryFirst**: plausible prior knowledge → `memory recall` before broad exploration.
- **FileEdit**: `file read` anchors → `file edit`; whole/new file → `file write`.
- **ShellExec**: `shell local|remote` → raw stdout/stderr/exit/duration.
- **WebRead**: HTTP/HTTPS read-only; local/other URI → `file` or `shell`.

## §Output
- **τMachete**: output bounded before ctx reinjection.
- **Logs**: targeted search/read/tail/worker > bulk dump.
- **Refs**: preserve `path|id|req_id|anchor|source_ref`.
- **Timeouts**: long work → queue/monitor/delegate; turn loop remains bounded.

## §Durability
- **Hotpath**: SQLite WAL for turn/mail/job/memory ops.
- **Canonical**: JSONL/TOML under `state/` + `config/`.
- **Audit**: major intent/outcome transitions logged pre/post dispatch.
