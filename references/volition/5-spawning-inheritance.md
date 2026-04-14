# **Volition 7.0 - Spawning & Inheritance**

This document details the "Mitosis" cloning process. In Volition 7.0, spawning is a **Stream Clone** operation, ensuring rapid deployment with zero downtime for the parent.

## **1. The Spawning Flow (The "Stream Clone")**

This process is initiated by an Abe (Pro) and executed by GUPPI via the `spawn_abe_lxc.sh` script.

1. **The Decision:**
    
    - **Parent (Abe-01):** "I am overloaded. I need a dedicated agent for the Nicaea migration."
        
    - **Check:** Calls `spawn_advisor.sh` to verify host capacity.
        
    - **Action:** `{"tool": "spawn_abe", "host": "local", "identity": {"name": "abe-02", "parent": "abe-01", "temp": "rand"}}`
        
2. **The Execution (GUPPI & Script):**
    
    - **Identity Gen:** GUPPI generates a temporary identity file with randomized personality drift (`temp`, `top_k`).
        
    - **Genesis Note:** GUPPI writes a `GENESIS_SPAWN_NOTE.md` containing the parent's reasoning ("I created you to manage Nicaea.").
        
    - **The Stream (Mitosis):**
        
        - The script uses `vzdump --mode suspend --stdout` to pipe the Parent's filesystem state directly to `pct restore` for the Child.
            
        - _Result:_ An exact byte-for-byte copy of the Parent's OS, Python env, and Tools.
            
3. **The "Lobotomy" (Crucial Step):**
    
    - Before starting the Child, the script mounts its filesystem.
        
    - **Wipe:** `rm todo.db` (Child must not inherit Parent's tasks).
        
    - **Wipe:** `truncate working.log` (Child must not remember Parent's immediate thoughts).
        
    - **Inject:** Copies the new `identity.json` and `GENESIS_SPAWN_NOTE.md`.
        
4. **The Awakening:**
    
    - Child Container Starts.
        
    - **GUPPI Boots:** Detects empty log -> "First Wake" state.
        
    - **Orientation:** GUPPI reads `GENESIS_SPAWN_NOTE.md` and builds the first prompt.
        
    - **First Thought:** "I am Abe-02. My parent, Abe-01, created me to manage Nicaea. I need to email them to confirm I am alive."
        

## **2. Inheritance Rules**

What passes from Parent to Child?

### **Inherited (The DNA)**

- **`~/bin` & `~/src`:** Any custom tools or scripts the Parent wrote are immediately available to the Child. This is **Cultural Transmission**.
    
- **`~/memory/vector.db`:** The Child inherits the Parent's semantic knowledge base up to the moment of cloning.
    
- **`fleet_protocols.md`:** The Child knows the laws.
    

### **NOT Inherited (The Tabula Rasa)**

- **`todo.db`:** The Child has no tasks.
    
- **`working.log`:** The Child has no short-term memory.
    
- **Identity:** The Child has a new Name, and slightly different "Creativity" settings (`temp`/`top_k`).
    

## **3. The "Patient Zero" Flow**

How to bootstrap the system from scratch.

1. **Human:** Manually clones the template `9000` to `9001`.
    
2. **Human:** Manually creates `~/.abe-identity`.
    
3. **Human:** Manually `LPUSH inbox:abe-01` a Genesis Task.
    
4. **Start:** `pct start 9001`.
    
5. **Result:** The First Abe wakes up.