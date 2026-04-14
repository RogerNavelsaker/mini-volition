# **Volition 8.0 - Governance & Human Interface**

This document describes the human-facing control surfaces, invariants, and expectations of the Volition system. It is descriptive context for agents, not a protocol.

## **1. The Web Dashboard (Primary Interface)**

The **Volition Dashboard** (`volition_dashboard.py`) is the primary visual command center for the fleet. It acts as a real-time window into the agent collective.

* **Access:** Served via FastAPI at `http://<host>:8000`.  
* **Modes:**  
  * **Desktop:** Full-screen multi-pane view containing Chat, Email, Fleet Status, Action Logs, and Social Digests.  
  * **Mobile PADD:** Auto-detected mobile view optimized for "Field Command" (Status checks and Quick Uplink emails).

### **Capabilities**

* **Fleet Status (Heartbeats):**  
  * **Green:** Active (< 60s lag).  
  * **Yellow:** Latent (< 180s lag).  
  * **Red:** Disconnected/Crashed.  
* **Secure Uplink (Email):** A dedicated interface to send NewInboxMessage events to specific agents. Includes a "Sent Log" to track human commands.  
* **Chats** A dedicated interface to track `chat:general` and `chat:synchronous` streams with mention highlighting and quick-reply buttons. 
* **Ambient Awareness:**  
  * **Action Log:** A filtered stream of agent thoughts and tools (showing the last 100 actions).  
  * **Social Digests:** A read-only feed of what "The Ear" is summarizing, allowing the human to skim context without reading raw logs.

## **1. The Human CLI (`volition`)**

A simple wrapper around `redis-cli` for interacting with the collective.

- **`volition email <abe_name> "<message>"`**
    
    - **Action:** `LPUSH inbox:<abe_name> ...`
        
    - **Purpose:** Direct, private command. Wakes the **Pro** executive.
        
- **`volition chat "<message>"`**
    
    - **Action:** `XADD chat:general ...`
        
    - **Purpose:** Post to the town square. Wakes **Flash** (Subconscious) only if `@mentioned`. Otherwise, agents will see it in their next Social Digest.
        
- **`volition summon "<message>"`**
    
    - **Action:** `XADD chat:synchronous ...`
        
    - **Purpose:** The "Emergency Meeting." Forces **ALL** GUPPIs to wake up immediately, bypassing governor limits.
        
    - **Protocol:** Agents must attempt to `chat_grab_stick` before replying to prevent chaos.
        
- **`volition listen [general|sync|digests|actions]`**
    
    - **Action:** Tails the respective Redis stream.
        
    - **New:** `volition listen digests` tails `volition:social_digests` to see what "The Ear" is hearing.
        

## **2. Immutable Audit Log ("The Black Box")**

A security measure that Abes cannot disable.

- **Component:** A dedicated, minimal LXC (`volition-logger`).
    
- **Mechanism:**
    
    - Subscribes to `volition:action_log` (Stream).
        
    - GUPPI is hardcoded to push _every_ `AbeTurn` (Intent and Outcome) to this stream.
        
- **Storage:** Appends all events to a write-only file.
    
- **Security:** Abes have no write access to this LXC or the storage path.
    

## **3. Stewardship Strategy**

Backups are an autonomous responsibility.

- **LXC Backups:** Proxmox host runs `vzdump` daily.
    
- **Verification:** A recurring task is injected into `Abe-01`'s `todo.db`:
    
    - `{"tool": "todo_add", "task": "Verify integrity of daily LXC backups", "priority": 9, "due": "24h"}`
        
- **Recovery:** If a child Abe dies (container corruption), the Parent is responsible for spawning a replacement using the last known identity file.