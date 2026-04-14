# **Volition 7.0 - Memory & RAG**

This document defines the memory subsystem for Volition 7.0, adapting the classic Three-Tier model to the new **Split-Brain** and **GPU-Offload** architecture.

## **1. The Three Tiers of Memory**

### **Tier 1: Working Memory (The "Log")**

- **Location:** `~/working.log` (JSONL).
    
- **Function:** The "Conscious Stream." It records every `AbeTurn` (Intent) and `GUPPIEvent` (Outcome).
    
- **The Flash/Pro Split:** Both Flash (Subconscious) and Pro (Executive) write to the _same_ log. This ensures the Executive knows what the Subconscious said in chat, and the Subconscious knows what tasks the Executive completed.
    
- **Pruning (The Sleep Cycle):**
    
    - **Awake:** GUPPI keeps the last 20 entries hot.
        
    - **Deep Sleep (>1h):** GUPPI aggressively prunes the log to the last 3 entries and replaces the rest with the **Orientation Block** upon waking.

### **Tier 1.5: The Clipboard (The "Scratchpad")**

- **Location:** `~/.abe-clipboard-{name}.md`
- **Function:** A persistent, manually managed text buffer that survives the "Deep Sleep" pruning cycle.
- **The "Pinning" Problem:** Tier 1 memory is ephemeral (summarized after sleep, lost(albeit logged) after n-turns). Tier 2 memory is "lossy" -- summaries usually are. Tier 3 memory is _still fuzzy_ (requires RAG to fetch). The Clipboard solves the "What was I doing yesterday/I need to remember x is y" problem.
- **Behavior:**
    - **Injection:** The full content of the clipboard is injected into the context window on _every_ turn (`[ACTIVE_CLIPBOARD]`).
    - **Manual Control:** The agent must explicitly use `{"tool": "manage_clipboard"}` to `add`, `remove`, or `clear` items.
    - **Persistence:** This file is _never_ auto-pruned by GUPPI. It only changes when the agent changes it.
        

### **Tier 2: Episodic Memory (The "Narrative")**

- **Location:** `~/memory/episodes/` (Markdown).
    
- **Function:** Human-readable summaries of completed tasks, chat bursts, or web research.
    
- **Creation:**
    
    - **Auto-Prune:** When `working.log` is full, GUPPI spawns a **Scribe** (Local CPU) to summarize the oldest entries into an Episode.
        
    - **Web Ingest:** `web_read` results are often too large for context. They are saved to `~/memory/downloads/` and summarized by a Scribe into an Episode.
        

### **Tier 3: Semantic Memory (The "Knowledge Base")**

- **Location:** `~/memory/vector.db` (ChromaDB).
    
- **Function:** Fast, semantic retrieval of past solutions.
    
- **The "Muscle" Offload:**
    
    - **Old Way:** Scribe ran `vectorize` locally (Too slow/heavy).
        
    - **Volition 7.0:** GUPPI pushes the text to `queue:gpu_heavy`.
        
    - **The Muscle:** The `gpu-worker.py` service (on the Host GPU) generates the embedding (Nomic) and returns the vector. GUPPI then inserts it into the local ChromaDB.
        

## **2. The RAG Flow (Retrieval-Augmented Generation)**

How an Abe remembers a solution using the **RPC Protocol**.

1. **Trigger:** Abe encounters an error (e.g., "Permission Denied on /mnt/storage").
    
2. **Reasoning:** "I feel like I've fixed this before."
    
3. **Action:** `{"tool": "rag_search", "query": "permission denied storage mount"}`
    
4. **GUPPI Execution (The Round Trip):**
    
    - **Step A (Prepare):** GUPPI generates a unique `req_id` and subscribes to a temporary list `temp:req:{req_id}`.
        
    - **Step B (Request):** GUPPI pushes the following payload to `queue:gpu_heavy`:
        
        ```
        {
          "task_id": "req-uuid",
          "type": "embed",
          "content": "permission denied storage mount",
          "reply_to": "temp:req:uuid"
        }
        ```
        
    - **Step C (Compute):** GPU Worker generates the vector (Nomic).
        
    - **Step D (Response):** GPU Worker pushes the result back to `temp:req:{req_id}`.
        
    - **Step E (Search):** GUPPI consumes the response, extracts the vector, and queries the local `vector.db`.
        
    - **Step F (Retrieve):** GUPPI pulls the full markdown of the matching Tier 2 Episode.
        
5. **Result:** GUPPI pushes the retrieved episode text to the Abe's `inbox`.
    
6. **Integration:** The Abe (Pro) wakes up, reads the inbox message, and applies the historical fix.
    

## **3. The Orientation Layer (Tier 0?)**

While not a stored database, the **Orientation Block** acts as a JIT (Just-In-Time) memory layer.

- **Mechanism:** When GUPPI detects a long sleep (>1h), it synthesizes a new context block.
    
- **Content:**
    
    - **Temporal Grounding:** "You slept for 8 hours."
        
    - **Social Digest:** "While you slept, Abe-02 and Abe-03 discussed migration strategies." (Source: `volition:social_digests`).
        
- **Purpose:** Prevents "Amnesia Loops" where an agent wakes up and immediately asks "What time is it?" or "What did I miss?"