# **Volition 7.0 - Log Schemas**

This file defines the strict JSON structures permitted in `working.log` and key system streams. GUPPI is the _only_ process authorized to write to `working.log`.

## **Scope Note**

These schemas apply to the persistent `working.log` and the inter-process streams defining the v7.0 architecture.

## **1. AbeTurn (The "Think" Cycle)**

This is the **Two-Phase Commit** log representing an agent's agency.

- **Stream:** `volition:action_log` (Also written to `working.log`)
    

### **Phase 1: "Intent" (Logged immediately after API return)**

```
{
  "id": "turn-uuid-1234",
  "type": "AbeTurn",
  "agent": "abe-03",
  "parent_event_id": "evt-001",
  "timestamp_intent": "2026-01-02T10:00:00Z",
  "status": "pending",
  "thought_signature": "(Optional) Internal CoT trace from the model",
  "reasoning": "I need to check the nginx logs to diagnose the 403 error.",
  "action": {
    "tool": "shell",
    "command": "tail -n 20 /var/log/nginx/error.log"
  },
  "results": null
}
```

### **Phase 2: "Outcome" (Patched after Async Execution)**

```
{
  "id": "turn-uuid-1234",
  "type": "AbeTurn",
  "agent": "abe-03",
  "parent_event_id": "evt-001",
  "timestamp_intent": "2026-01-02T10:00:00Z",
  "timestamp_outcome": "2026-01-02T10:00:02Z",
  "status": "completed",
  "thought_signature": "...",
  "reasoning": "I need to check the nginx logs to diagnose the 403 error.",
  "action": {
    "tool": "shell",
    "command": "tail -n 20 /var/log/nginx/error.log"
  },
  "results": {
    "stdout": "2026/01/02 10:00:01 [error] ... permission denied",
    "stderr": "",
    "code": 0
  }
}
```

### **Clipboard Management (Special Action Schema)**

When managing Tier 1.5 memory, the `action` field follows these patterns:

**Add Item:**
```json
{
  "tool": "manage_clipboard",
  "action": "add",
  "content": "Remember: X Server uses fish shell."
}
```

**Remove Item:**
```json
{
  "tool": "manage_clipboard",
  "action": "remove",
  "index": 1,
  "indices": [1, 3] 
}
```

## **2. GUPPIEvent (The "Interrupt")**

Logged by GUPPI when an external signal wakes the agent.

**Example 1: New Inbox Message (Standard Wake)**

```
{
  "id": "evt-001",
  "type": "GUPPIEvent",
  "agent": "abe-03",
  "timestamp_event": "2026-01-02T09:59:59Z",
  "event_type": "NewInboxMessage",
  "source": "inbox:abe-03",
  "content": "Alert: Nginx is down on Nicaea.",
  "from": "abe-01"
}
```

**Example 2: Social Digest (Orientation Wake)** _Source Stream: `volition:social_digests`_

```
{
  "id": "evt-002",
  "type": "GUPPIEvent",
  "agent": "abe-03",
  "timestamp_event": "2026-01-02T10:05:00Z",
  "event_type": "SocialDigest",
  "source": "volition:social_digests",
  "content": {
    "start_ts": 1735810000.0,
    "end_ts": 1735813600.0,
    "msg_count": 15,
    "participants": ["abe-01", "abe-02"],
    "summary": "Abe-01 and Abe-02 discussed the Nicaea migration."
  }
}
```

**Example 3: Task Completion (Self-Wake)**

```
{
  "id": "evt-003",
  "type": "GUPPIEvent",
  "agent": "abe-03",
  "timestamp_event": "2026-01-02T10:00:02Z",
  "event_type": "TaskCompleted",
  "source": "GUPPI",
  "content": {
    "status": "success",
    "stdout": "..."
  },
  "action_id": "turn-uuid-1234"
}
```

## **3. GPU Offload Protocol (The Muscle)**

- **List:** `queue:gpu_heavy`
    
- **Response:** Pushed to `reply_to` list.
    

**Request Payload:**

```
{
  "task_id": "req-uuid-5678",
  "type": "embed", 
  "content": "The text to be vectorized...",
  "reply_to": "temp:req:uuid-5678"
}
```

**Response Payload:**

```
{
  "type": "GUPPIEvent",
  "event": "ScribeResult",
  "task_id": "req-uuid-5678",
  "status": "success",
  "content": {
    "vector": [0.0123, -0.456, ...]
  },
  "meta": { "worker": "gpu_5070ti", "model": "nomic-embed-text" }
}
```