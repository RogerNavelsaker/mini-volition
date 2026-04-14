# Volition GUPPI Loop Notes

Source: https://github.com/AIndoria/volition/blob/main/docs/current/Volition-3-GUPPI-Loop_Architecture.md

Behavior cues relevant to `.fleet`:

- The original system uses a refractory scheduler instead of processing every source equally.
- "Always hot" inputs include urgent synchronous streams, internal queue activity, and local wakeups.
- Workload inputs like inbox tasks and scheduled tasks are gated during cooldown windows.
- After workload execution, cooldown exists to preserve thinking space and avoid runaway loops.
- Orientation logic changes based on time asleep and recent social digests.

How this informs `.fleet`:

- Hot wakes should be allowed during cooldown.
- Workload wakes should be deprioritized or suppressed during refractory windows.
- Wake selection should be explicit, durable, and explainable.
- Sleep/orientation behavior should remain a harness responsibility.
