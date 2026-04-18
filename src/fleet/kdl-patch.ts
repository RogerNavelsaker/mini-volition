import { readFileSync, writeFileSync, existsSync } from "fs";

export type AgentConfig = {
  name: string;
  model: string;
  socket: string;
};

export type FleetConfig = {
  agents: AgentConfig[];
};

export function loadFleetConfig(configPath: string, defaults: AgentConfig[] = []): FleetConfig {
  if (!existsSync(configPath)) return { agents: defaults };
  try {
    const data = JSON.parse(readFileSync(configPath, "utf-8"));
    if (Array.isArray(data.agents)) return { agents: data.agents };
  } catch {
    // fall through to defaults
  }
  return { agents: defaults };
}

export function saveFleetConfig(configPath: string, config: FleetConfig): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function addAgentToConfig(config: FleetConfig, agent: AgentConfig): FleetConfig {
  const filtered = config.agents.filter((a) => a.name !== agent.name);
  return { agents: [...filtered, agent] };
}

export function removeAgentFromConfig(config: FleetConfig, agentName: string): FleetConfig {
  return { agents: config.agents.filter((a) => a.name !== agentName) };
}

export function generateAgentPane(agent: AgentConfig, runtimeDir: string): string {
  const resolve = (name: string) => `${runtimeDir}/${name}`;
  return `
                pane name="${agent.name.toUpperCase()}" command="bash" {
                    args "-lc" "AGENT_NAME=${agent.name} AGENT_PROMPT_MODE=provider INFERENCE_CLOUD_SOCKET='${resolve(agent.socket)}' INFERENCE_CLOUD_MODEL='${agent.model}' INFERENCE_CLOUD_ANTHROPIC_SOCKET='${resolve("claude.sock")}' INFERENCE_CLOUD_GOOGLE_SOCKET='${resolve("gemini.sock")}' INFERENCE_CLOUD_OPENAI_SOCKET='${resolve("openai.sock")}' INFERENCE_CLOUD_OPENROUTER_SOCKET='${resolve("openrouter.sock")}' AGENT_MAIL_BIN='agent-mail' AGENT_MAIL_DB='${resolve("agent-mail.db")}' AGENT_JOBS_DB='${resolve("agent-jobs.db")}' AGENT_MEMORY_DB='${resolve("agent-memory.db")}' AGENT_STATE_DB='${resolve("agent-state.db")}' FLEET_LIBRARIAN_DB='${resolve("fleet-librarian.db")}' INFERENCE_LOCAL_EMBED_SOCKET='${resolve("embed.sock")}' INFERENCE_LOCAL_SMALL_SOCKET='${resolve("light.sock")}' INFERENCE_LOCAL_MEDIUM_SOCKET='${resolve("heavy.sock")}' agent-runtime < /dev/null"
                }`;
}

export function generateKdlFromConfig(config: FleetConfig, runtimeDir: string): string {
  const resolve = (name: string) => `${runtimeDir}/${name}`;
  const agentPanes = config.agents.map((a) => generateAgentPane(a, runtimeDir)).join("");

  return `layout {
    default_tab_template {
        children
        pane size=1 borderless=true {
            plugin location="zellij:status-bar"
        }
    }

    tab name="agents" {
        pane split_direction="horizontal" {
            pane split_direction="vertical" {${agentPanes}
            }
            pane split_direction="vertical" {
                pane name="TOWN SQUARE" command="bash" {
                    args "-lc" "AGENT_MAIL_DB='${resolve("agent-mail.db")}' agent-mail tail public < /dev/null"
                }
                pane name="DIGEST" command="bash" {
                    args "-lc" "AGENT_MAIL_DB='${resolve("agent-mail.db")}' AGENT_MEMORY_DB='${resolve("agent-memory.db")}' AGENT_STATE_DB='${resolve("agent-state.db")}' AGENT_MAIL_BIN='agent-mail' INFERENCE_LOCAL_SMALL_SOCKET='${resolve("light.sock")}' fleet-reporter < /dev/null"
                }
                pane name="MEMORY" command="bash" {
                    args "-lc" "AGENT_JOBS_DB='${resolve("agent-jobs.db")}' AGENT_MEMORY_DB='${resolve("agent-memory.db")}' AGENT_STATE_DB='${resolve("agent-state.db")}' FLEET_LIBRARIAN_DB='${resolve("fleet-librarian.db")}' AGENT_MEMORY_BIN='agent-memory' fleet-librarian < /dev/null"
                }
                pane name="OPERATOR" focus=true command="bash" {
                    args "-lc" "AGENT_MAIL_DB='${resolve("agent-mail.db")}' operator-console"
                }
            }
        }
    }

    tab name="providers" {
        pane split_direction="horizontal" {
            pane split_direction="vertical" {
                pane name="CLAUDE-API" command="bash" {
                    args "-lc" "INFERENCE_CLOUD_ANTHROPIC_SOCKET='${resolve("claude.sock")}' inference-cloud-anthropic < /dev/null"
                }
                pane name="GEMINI-API" command="bash" {
                    args "-lc" "INFERENCE_CLOUD_GOOGLE_SOCKET='${resolve("gemini.sock")}' inference-cloud-google < /dev/null"
                }
            }
            pane split_direction="vertical" {
                pane name="OPENAI-API" command="bash" {
                    args "-lc" "INFERENCE_CLOUD_OPENAI_SOCKET='${resolve("openai.sock")}' inference-cloud-openai < /dev/null"
                }
                pane name="OPENROUTER-API" command="bash" {
                    args "-lc" "INFERENCE_CLOUD_OPENROUTER_SOCKET='${resolve("openrouter.sock")}' inference-cloud-openrouter < /dev/null"
                }
            }
        }
    }

    tab name="inference" {
        pane split_direction="horizontal" {
            pane split_direction="vertical" {
                pane name="EMBED" command="bash" {
                    args "-lc" "INFERENCE_LOCAL_EMBED_SOCKET='${resolve("embed.sock")}' inference-local-embed < /dev/null"
                }
                pane name="RERANK" command="bash" {
                    args "-lc" "INFERENCE_LOCAL_RERANK_SOCKET='${resolve("rerank.sock")}' inference-local-rerank < /dev/null"
                }
            }
            pane split_direction="vertical" {
                pane name="LIGHT" command="bash" {
                    args "-lc" "INFERENCE_LOCAL_SMALL_SOCKET='${resolve("light.sock")}' inference-local-small < /dev/null"
                }
                pane name="HEAVY" command="bash" {
                    args "-lc" "INFERENCE_LOCAL_MEDIUM_SOCKET='${resolve("heavy.sock")}' inference-local-medium < /dev/null"
                }
            }
        }
    }
}
`;
}

export function patchKdl(configPath: string, layoutPath: string, runtimeDir: string, defaults: AgentConfig[] = []): void {
  const config = loadFleetConfig(configPath, defaults);
  const kdl = generateKdlFromConfig(config, runtimeDir);
  writeFileSync(layoutPath, kdl, "utf-8");
}
