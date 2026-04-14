# **Volition 7.0 - The GUPPI Loop (Technical Plan)**

This document details the technical implementation of the `guppi.py` daemon (v7.0), encompassing the Orientation logic, Split-Brain decision making, and the async execution cycle.

## **1. GUPPI's Main State: The Refractory Scheduler**

GUPPI does not simply "wait for everything." It implements a **Refractory Scheduler** that prioritizes sensory input over workload to prevent runaway feedback loops.

### **Group A: Always Hot (Senses)**
These inputs are monitored 24/7 and processed immediately, even during cooldowns.
1. **Streams:** `xread(active_streams)`. Mentions (`@abe`) and Emergency Channels (`chat:synchronous`).
2. **Internal Queue:** `blpop(internal:abe)`. RPC returns from GPU workers and Scribes.
3. **Local Wakeup:** `asyncio.Event`. Triggers when a local subprocess finishes.

### **Group B: Refractory (Workload)**
These inputs are only processed when the agent is **Cool** (not in a refractory period).
1. **Inbox:** `blpop(inbox:abe-name)`. New tasks, emails, or non-urgent alerts.
2. **Alarm Clock:** `asyncio.sleep(next_task_delta)`. Scheduled tasks from `todo.db`.

**The Cooldown Logic:**
After completing a Group B task, GUPPI sets `cooldown_until = now + random(10, 30)`. During this window, it ignores the Inbox to allow for "Thinking Space" and to prevent token-budget exhaustion.
    

## **2. Anatomy of a Turn (The v7.0 Cycle)**

### **Phase 1: The Wake & Orient**

1. **Interrupt:** A task completes (e.g., Inbox message received).
    
2. **Sleep Calculation:** GUPPI compares `now()` with `self.last_sleep_ts`.
    
3. **Social Sync:**
    
    - GUPPI queries `volition:social_digests` for entries created between `last_social_sync_ts` and `now()`.
        
    - These are archived to `communications.log` and held in memory.
        
4. **Context Synthesis:**

    - **[ACTIVE_CLIPBOARD]**: The persistent Tier 1.5 notes.
    
    - If **Time Asleep > 1 Hour**:
        
        - **Pruning:** Working memory is aggressively pruned to the last 3 items.
            
        - **Injection:** An `[ORIENTATION]` block is added to the prompt, containing the sleep duration and the fetched Social Digests.
            
    - If **Time Asleep < 1 Hour**:
        
        - Standard context (Last 20 log items) is used.
            

### **Phase 2: The Split-Brain Think Cycle**

GUPPI determines which "lobe" of the brain to activate based on the trigger event.

1. **Event Analysis:**
    
    - **Chat Event:** Triggers **Flash** (e.g., Gemini 2.5 Flash).
        
    - **Inbox/Task/Alarm:** Triggers **Pro** (e.g., Gemini 2.5 Pro).
        
2. **API Call:** GUPPI sends the synthesized context to the selected model.
    
3. **Escalation Check (The Safety Valve):**
    
    - If **Flash** is active but attempts to use a "Heavy Tool" (e.g., `shell`, `write_file`, `spawn_abe`), GUPPI **denies** the action.
        
    - **Escalation:** GUPPI immediately re-runs the Think Cycle using **Pro**, injecting a `[SYSTEM NOTICE]` explaining that the chat layer requested a privileged action.
        

### **Phase 3: Execution & Logging**

1. **Intent Log:** GUPPI writes the `AbeTurn` (Status: Pending) to `working.log`.
    
2. **Async Execution:**
    
    - **Shell/Scribe:** Spawned as `asyncio.subprocess`.
        
    - **Redis/File:** Executed immediately via `await`.
        
    - **GPU Offload:** Pushed to `queue:gpu_heavy`.
        
3. **Outcome Patching:**
    
    - When the task completes (potentially seconds or minutes later), GUPPI wakes up (Local Wakeup).
        
    - It finds the pending `AbeTurn` in `working.log` and patches it with `Status: Completed` and the `Results`.
        
4. **Notification:** GUPPI pushes a `TaskCompleted` event to its _own_ inbox to trigger the next cognitive step.
    

## **3. Scribe & Compute Architecture**

Volition 7.0 bifurcates "Tasking" into Local (CPU) and Remote (GPU) workloads.

### **The Scribe (Local CPU)**

- **Spawned By:** `spawn_scribe` tool or GUPPI Auto-Pruner.
    
- **Execution:** Runs as a child process of the Abe container.
    
- **Use Case:** Summarizing text, parsing logs, "Watching" a file.
    
- **Limitation:** cannot perform vector operations.
    

### **The Muscle (Remote GPU)**

- **Spawned By:** Redis Push to `queue:gpu_heavy`.
    
- **Execution:** Runs on the Host Workstation (Sense-of-Proportion).
    
- **Use Case:**
    
    - **Embedding:** Generating vectors for `rag_search` or Tier 3 Memory.
        
    - **Heavy Summarization:** Crunching large datasets using Mistral-Small.
        
- **RPC Pattern:**
    
    1. GUPPI generates a `req_id` and a temporary reply queue `temp:req:{id}`.
        
    2. Pushes payload to `queue:gpu_heavy`.
        
    3. Blocks (with timeout) on `temp:req:{id}` waiting for the JSON result.

## **4. Safety & Reliability**

### **The Deadman Switch (Anti-Ghosting)**
If GUPPI initiates a `run_think_cycle` (sends a prompt to the LLM) but execution halts due to a crash, API timeout, or unhandled exception, the event is considered "Ghosted."
- **Detection:** The `run_think_cycle` wraps the entire logic in a `try/finally` block.
- **Recovery:** If the cycle exits without flagging `cycle_success`, GUPPI pushes an `AgentGhosted` alert to the agent's Inbox. This ensures the agent is aware that it "blacked out" and can investigate the failure.

### **The Output Machete**
To prevent context window overflow (and massive API costs), GUPPI enforces a strict limit (e.g., 20,000 chars) on all command outputs (`stdout`/`stderr`).
- **Behavior:** Any output exceeding the limit is hard-truncated.
- **Notification:** A warning tag `... [TRUNCATED BY GUPPI SAFETY] ...` is appended to the log, informing the agent why it cannot see the full file.
- **Appropriate Circumvention:** Agents can always spawn a scribe to summarize a file, or find a specific thing in a file, or ask for an offset from the scribe where x or y happens, and verify the scribe's findings and investigate themselves.