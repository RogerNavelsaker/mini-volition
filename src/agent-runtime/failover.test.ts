import { describe, expect, test } from "bun:test";
import { buildProviderTargets, executeProviderTargets, type ProviderTurnTarget } from "./failover";

describe("Provider failover", () => {
  test("buildProviderTargets adds configured fallback providers for full turns", () => {
    const targets = buildProviderTargets(
      "/runtime/openai.sock",
      "o3",
      "full",
      {
        anthropic: "/runtime/claude.sock",
        google: "/runtime/gemini.sock",
        openai: "/runtime/openai.sock",
        openrouter: "/runtime/openrouter.sock",
      },
      {
        INFERENCE_CLOUD_FAILOVER_ORDER: "openrouter,anthropic,google",
        INFERENCE_CLOUD_OPENROUTER_MODEL: "openrouter/auto",
        INFERENCE_CLOUD_ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
        INFERENCE_CLOUD_GOOGLE_MODEL: "gemini-2.5-pro",
      },
    );

    expect(targets.map((target) => target.provider)).toEqual(["openai", "openrouter", "anthropic", "google"]);
    expect(targets.map((target) => target.model)).toEqual(["o3", "openrouter/auto", "claude-sonnet-4-20250514", "gemini-2.5-pro"]);
  });

  test("buildProviderTargets keeps light profile on the primary provider", () => {
    const targets = buildProviderTargets(
      "/runtime/claude.sock",
      "claude-sonnet-4-20250514",
      "light",
      {
        anthropic: "/runtime/claude.sock",
        google: "/runtime/gemini.sock",
        openai: "/runtime/openai.sock",
        openrouter: "/runtime/openrouter.sock",
      },
      {
        INFERENCE_CLOUD_FAILOVER_ORDER: "openrouter,openai",
        INFERENCE_CLOUD_OPENROUTER_MODEL: "openrouter/auto",
        INFERENCE_CLOUD_OPENAI_MODEL: "o3",
      },
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]?.provider).toBe("anthropic");
  });

  test("executeProviderTargets fails over to the next configured provider", async () => {
    const targets: ProviderTurnTarget[] = [
      { provider: "openai", socketPath: "/runtime/openai.sock", model: "o3" },
      { provider: "openrouter", socketPath: "/runtime/openrouter.sock", model: "openrouter/auto" },
    ];
    const attempts: string[] = [];

    const result = await executeProviderTargets(
      "full",
      targets,
      async (target) => {
        attempts.push(target.provider);
        if (target.provider === "openai") {
          return {
            content: "",
            usage: { input_tokens: 0, output_tokens: 0 },
            model: target.model,
            source: target.provider,
            stop_reason: "error",
            error: "primary failed",
          };
        }
        return {
          content: "{\"actions\":[{\"type\":\"noop\"}]}",
          usage: { input_tokens: 1, output_tokens: 1 },
          model: target.model,
          source: target.provider,
          stop_reason: "stop",
        };
      },
      { sleep: async () => {} },
    );

    expect(attempts).toEqual(["openai", "openrouter"]);
    expect(result.source).toBe("openrouter");
    expect(result.stop_reason).toBe("stop");
  });
});
