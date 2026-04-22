---
name: flywheel-loop
description: Implements the 6-stage Agent Flywheel loop (Plan, Encode, Triage, Coordinate, Implement, Close) to orchestrate autonomous engineering work. Use as the foundational operational cycle for all project work.
---

# Agent Flywheel Loop

The Flywheel is a self-reinforcing cycle that moves work from high-level architecture (Plan Space) to executable tasks (Encode Space) and finally to verified code (Code Space).

## 1. Plan (Plan Space)
Create or update a **Trellis Spec** (`tl spec`).
- **Goal**: Resolve architecture, edge cases, and constraints while the system still fits in a single context window.
- **Output**: A comprehensive Markdown document (aim for high detail) that defines the "What" and "Why".
- **Tool**: `tl spec update <id> --objective "..." --constraint "..." --acceptance "..."`

## 2. Encode (Encode Space)
Translate the Plan into **Seeds** (the equivalent of Flywheel "Beads").
- **Goal**: Create self-contained, dependency-aware tasks.
- **Output**: Interconnected Seeds issues.
- **Tool**: `sd create`, `sd dep add <child> <parent>`.

## 3. Triage
Select the highest-leverage "ready" task from the graph.
- **Goal**: Focus on unblocked work that unblocks the most downstream tasks.
- **Tool**: `triage-work` (Skill), `sd ready`, `sd stats`.

## 4. Coordinate
Use **Coordinating Agents** primitives to prevent merge conflicts and align with other agents/operator.
- **Goal**: prevent duplicate work, announce intent, and transfer control safely.
- **Tool**: `coordinating-agents` (Skill), `ctx_agent`, `sd update`, `tl handoff`.

## 5. Implement (Code Space)
Implement and test locally.
- **Goal**: Code and test. This should be a "foregone conclusion" if Plan/Encode were thorough.
- **Output**: Verified code changes on a feature branch.
- **Tool**: `git worktree`, `bun test`, `bun run lint`.

## 6. Close / Verify
Perform self-review and close the task.
- **Goal**: Verify behavioral correctness and structural integrity.
- **Tool**: `closing-sessions` (Skill), `sd close`, `ml record`.

## 7. Refine (Recursive Improvement)
Update skills based on recorded learnings.
- **Goal**: Ensure the system improves itself.
- **Tool**: `refining-skills` (Skill), `ml search`.

## Core Mandate
- **Plan-Centric Autonomy**: 85% of effort belongs in Plan Space.
- **Fungibility**: All coordination lives in artifacts (Seeds, Specs, Mail), not agent memory.
- **Recursive Improvement**: Use `ml record` to identify failure patterns and update these skills.
