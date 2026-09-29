# §DocStyle
Bounded Token Dense Dialect for durable repo docs.

## §Goal
- **Dense**: each line carries protocol/design meaning.
- **Readable**: human-maintainable project shorthand.
- **Stable**: durable project refs and stable artifact names.
- **CtxReady**: injectable/summarizable for replicants as-is.

## §Symbols
- **§**: section/domain.
- **τ**: component/actor/type/service.
- **∂**: interface/protocol boundary.
- **∆**: change/transition/lifecycle step.
- **→**: output/target/result/flow.
- **↑**: escalation/priority increase.
- **StatusMark**: status glyphs only when clearer than words.
- **TOON**: harness/model edge format for flat/repeated tool reqs, tool results, and ctx rows.
- **TOONRows**: rows stay flat; use a few stable top-level primitive fields so one object maps cleanly to one row.
- **JSON**: canonical harness representation after TOON decode; public req rows stay flat.

## §Abbrev
Allowed when meaning is obvious in ctx.
- `ctx`: ctx.
- `cfg`: cfg.
- `impl`: impl.
- `req`: req.
- `res`: res/result.
- `ref`: reference.
- `id`: identifier.
- `env`: environment.
- `op`: operation.

## §Rules
- Headers + bullets; short paragraphs.
- Prefer project terms: `replicant`, `harness`, `worker`, `clipboard`, `todo`, `memory recall`, `file read`, `shell local`, `shell remote`.
- Use current runtime terms only for existing impl: `scratchpad`, `spawn_scribe`, current JSON action envelope.
- Canonical docs use mini-volition terms: `replicant`, `harness`, `memory recall`, `clipboard`, `todo`, `replicant-tool`.
- Durable docs use real paths, stable refs, and durable identifiers.
- Conceptual docs use light symbols; protocol/spec docs use stronger TDD.
- Apply the same bounded TDD to turn ctx assembly. Replicants read assembled ctx every turn; ctx blocks are terse, structured, and grep-friendly.
- Use short stable labeled blocks plus TOON/JSON payloads for clipboard, todos, datetime, memory, burst, and reminder sections.
- Turn ctx uses short labels for provider prompt-cache stability and recurring-token efficiency; docs keep long aliases only when explaining meaning.
- Tool use uses TOON req tables at the harness/model edge; the harness decodes to flat JSON rows and validates decoded objects fail-closed.
- TOON rows use top-level primitive fields.
- Keep source-of-truth facts grep-friendly.

## §DocClasses
- **StrongTDD**: `ARCHITECTURE.md`, `3-turn-loop.md`, `6-schemas.md`, `fleet-protocols.md`.
- **MediumTDD**: `2-core-architecture.md`, `4-memory.md`, `5-topology.md`, `7-governance.md`.
- **LightTDD**: `1-philosophy.md`, `genesis.md`.
