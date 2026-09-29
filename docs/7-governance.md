# §Governance

## §WakeControl
- **τRefractory**: Two-group wake throttling; hot senses bypass ordinary workload cooldown.
- **τHotSenses**: Urgent streams, direct mentions, internal worker returns, local wakeups, and operator signals.
- **τRefractoryWorkload**: Inbox and due-todo wakes are throttled by governor cooldown.
- **τDynamicSub**: Subscription/focus controls adjust ambient chat attention.
- **τFocus**: Auto-suspend noisy channels only with a reminder/todo when later review matters.

## §Authority
- **HarnessBoundary**: Replicant expresses intent; harness validates, executes, normalizes, records.
- **SubstrateBoundary**: Filesystem, process, network, territory, and remote-exec restrictions are enforced below runtime doctrine.
- **RoleScope**: Devops-replicant has broader lifecycle/territory authority; code-replicant and personal-assistant default to own class.
- **WorkerScope**: Temporary workers receive only invocation-bound grants.
- **SubstrateSafety**: Safety comes from enforced substrate boundaries plus audit.

## §Reviewability
- **τAudit**: Durable pre-dispatch and post-outcome records.
- **τBlackBox**: Intent and outcome are reviewable; audit truth is append-owned by harness.
- **StrictEnvelope**: Malformed or unknown actions fail closed.
- **Evidence**: Partial, bounded, stale, rejected, and failed results are visible to the replicant.
- **Ownership**: Functional isolation keeps mail, jobs, memory, state, and fleet governance separable.

## §HumanInterface
- **ControlPlane**: Operator console/dashboard is the human control plane.
- **Escalation**: Use for blockers, unclear intent, repeated failure, urgent safety, or high-impact irreversible actions.
- **Signal**: Direct operator mail wakes strongly and enters assembled turn context.
- **Visibility**: Fleet status, action logs, social digests, mail, chat, and audit views are inspectable through read surfaces.
