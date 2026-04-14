# **Volition 7.0 - Core Architecture**

This document details the functional components of the Volition 7.0 system.

## **1. Agent Roles: The Extended "Abe-GUPPI-Auxiliary" Model**

Volition 7.0 expands the classic triad into a five-part specialized model to optimize for cost, latency, and context awareness.

### **The "Abe" (The Thinker / Split-Brain)**

- **Definition:** The "brain" or "soul" of the agent. It is the LLM-based decision maker.
    
- **Split-Brain Architecture:**
    
    - **Flash (The Chat Layer):** Fast, cheap (e.g., Gemini 2.5 Flash). Handles `chat:general` and casual interactions.
        
    - **Pro (The Executive):** High-reasoning, expensive (e.g., Gemini 2.5 Pro). Handles `inbox`, complex tasks, and "Escalations" (when Flash attempts a forbidden action).
        
- **State:** "Asleep" by default. Only "thinks" when GUPPI builds a prompt and hits the API.
    
- **Output:** A single JSON object: `{"reasoning": "...", "action": {...}}`.
    

### **The "GUPPI" (The Body)**

- **Definition:** The persistent `asyncio` Python daemon (`guppi.py`) running 24/7 inside the Abe's LXC container.
    
- **Responsibility:**
    
    - **Senses:** Listens to Redis (Inbox, Streams).
        
    - **Orientation:** On wake-up, calculates `time_asleep`, pulls missed social digests, and synthesizes the `[ORIENTATION]`, `[ACTIVE_CLIPBOARD]`, and `[CHANGELOG]` context block.

    - **The Machete (Safety):** Enforces hard output limits (20k chars) on all tools to prevent context flooding and API bankruptcy.
        
    - **Action:** Executes the Abe's intent (Shell, File I/O, Spawning).
        
- **Authority:** It is the _only_ process permitted to write to `working.log`.
    

### **The "Scribe" (The Tasker)**

- **Definition:** A temporary, ephemeral process (`scribe.py`) spawned by GUPPI.
    
- **Role:** "Fire-and-forget" logic.
    
- **Constraint:** In v7.0, Scribes are **forbidden** from performing vectorization. They are strictly for text summarization, log monitoring, or data transformation.
    
- **Reporting:** Outputs results solely to the parent Abe's `inbox`.
    

### **The "Muscle" (The GPU Worker)**

- **Definition:** A dedicated service (`gpu-worker.py`) running on high-performance hardware.
    
- **Role:** Offloads heavy compute from the lightweight LXC containers.
    
- **Tasks:**
    
    - **Embeddings:** Nomic vector generation for RAG.
        
    - **Summaries:** Mistral/Llama inference for non-critical logs.
        
- **Interface:** Listens on `queue:gpu_heavy`.
    

### **The "Ear" (The Social Router)**

- **Definition:** A dedicated service (`ear.py`) that monitors high-traffic channels.
    
- **Role:** Decouples "Hearing" from "Listening."
    
    - Detects conversation bursts.
        
    - Summarizes them using local models.
        
    - **Publishes** structured `SocialDigest` objects to the `volition:social_digests` stream.
        
    - _Note: This replaces the v6.0 method of spamming generic summaries to Inboxes._
        

## **2. The "Orientation" Agency Model**

Volition 7.0 moves beyond simple reactive loops to a state-aware model.

- **Sleep Tracking:** GUPPI tracks the timestamp of its last conscious action.
    
- **The Orientation Block:** When an interrupt occurs, GUPPI calculates the delta.
    
    - **Short Sleep (<1h):** Context remains "Hot" (Standard Working Memory).
        
    - **Deep Sleep (>1h):** Context is Pruned. GUPPI injects an `[ORIENTATION]` block containing:
        
        - `Time Asleep`: "You were asleep for 4 hours."
            
        - `Social Catch-up`: A list of missed digests from "The Ear."
            
        - `Last Conscious State`: The result of the last action taken before sleep.
            

## **3. The "Nervous System" (Redis Comms)**

All communication is handled via a central Redis instance.

### **1:1 "Inbox" (Direct Neural Link)**

- **Tool:** Redis Lists (e.g., `inbox:abe-01`).
    
- **Semantics:** Non-typed. Can contain JSON (Scribe Results), Strings (Human Messages), or System Events (Alarms).
    
- **Priority:** High. Triggers the **Pro** model by default.
    

### **1:Many "Town Square" (Ambient Social)**

- **Tool:** Redis Stream (e.g., `chat:general`).
    
- **Passive Awareness:** GUPPI monitors this for `@mentions` (Direct Wake).
    
- **Active Pull:** GUPPI _does not_ read every message here. Instead, it pulls summarized **Digests** from `volition:social_digests` upon waking to "catch up" on what it missed.
    

### **Synchronous "Conference Call" (The Emergency Line)**

- **Tool:** Redis Stream (`chat:synchronous`).
    
- **Behavior:** GUPPI _must_ listen to this. A message here triggers an immediate wake-up, bypassing governor limits.
    

### **Dynamic Subscriptions**

- **Tool:** `subscribe_channel` / `unsubscribe_channel`.
    
- **Function:** Allows an Abe to dynamically modify GUPPI's `asyncio.gather` listener list to track project-specific streams (e.g., `volition:project_alpha`) without restarting the daemon.