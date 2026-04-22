---
name: refining-skills
description: Recursively improves the agent toolchain. Analyzes failure patterns and successful workflows from mulch records to update and refine the .llm/skills/ instructions. Ensures the collective intelligence of the system compounds over time.
---

# Refining skills

The Flywheel is a learning system. Use this skill to transform tacit operational lore (captured in `mulch`) into executable instructions (`SKILL.md`).

## When to trigger

- A task is closed, and significant learnings were recorded in `mulch`.
- A recurring failure pattern is identified in `ml search` hits.
- A new project-specific convention is established.
- A tool update changes the optimal workflow.

## Flow

1. **Harvest Learnings**:
   ```
   ml search --type failure
   ml search --type convention
   ```
   Identify hits from the current project phase.

2. **Draft Refinement**:
   - Compare current `SKILL.md` instructions with the recorded learnings.
   - Update steps, rules, or flow to prevent past mistakes or incorporate new shortcuts.

3. **Verify and Apply**:
   - Use `write_file` or `replace` to update the skill.
   - Run `cn sync` if the skill is linked to a canopy prompt.

4. **Communicate**:
   - Broadcast the refinement:
     ```typescript
     ctx_agent({
       action: "post",
       category: "status",
       message: "Refined skill: <name>. Incorporating new consensus on <topic>."
     })
     ```

## Rules

- Keep skills small and atomic. If a skill grows too large, split it.
- Never delete a safety rule unless the underlying tool makes it redundant.
- Always use TDD (Token Dense Dialect) in skills to minimize context usage.
