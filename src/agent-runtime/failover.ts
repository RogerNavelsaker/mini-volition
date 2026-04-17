import { retryConfig, type TurnProfile } from "./policy";

export type ProviderKind = "anthropic" | "google" | "openai" | "openrouter";

export type ProviderSockets = Record<ProviderKind, string>;

export type ProviderTurnTarget = {
  provider: ProviderKind;
  socketPath: string;
  model: string;
};

export type ProviderTurnResult = {
  stop_reason: string;
  error?: string;
  source?: string;
  model?: string;
};

const PROVIDERS: ProviderKind[] = ["anthropic", "google", "openai", "openrouter"];

function providerEnvPrefix(provider: ProviderKind): string {
  return `INFERENCE_CLOUD_${provider.toUpperCase()}`;
}

function parseFailoverOrder(value: string | undefined): ProviderKind[] {
  if (!value?.trim()) return ["openrouter", "openai", "anthropic", "google"];
  const parsed = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is ProviderKind => PROVIDERS.includes(entry as ProviderKind));
  return parsed.length > 0 ? [...new Set(parsed)] : ["openrouter", "openai", "anthropic", "google"];
}

export function inferPrimaryProvider(
  primarySocket: string,
  sockets: ProviderSockets,
): ProviderKind | null {
  const match = PROVIDERS.find((provider) => sockets[provider] === primarySocket);
  return match ?? null;
}

function resolveProviderModel(
  provider: ProviderKind,
  profile: TurnProfile,
  env: Record<string, string | undefined>,
): string | null {
  const prefix = providerEnvPrefix(provider);
  const profileSpecific = profile === "max"
    ? env[`${prefix}_MAX_MODEL`] ?? env[`${prefix}_MODEL`]
    : env[`${prefix}_MODEL`];
  return profileSpecific?.trim() ? profileSpecific.trim() : null;
}

export function buildProviderTargets(
  primarySocket: string,
  primaryModel: string | null,
  profile: TurnProfile,
  sockets: ProviderSockets,
  env: Record<string, string | undefined> = process.env,
): ProviderTurnTarget[] {
  const primary = inferPrimaryProvider(primarySocket, sockets);
  const primaryTarget = primaryModel?.trim()
    ? [{ provider: primary ?? "openai", socketPath: primarySocket, model: primaryModel.trim() }]
    : [];

  if (!primary || profile === "light") return primaryTarget;

  const fallbackOrder = parseFailoverOrder(env.INFERENCE_CLOUD_FAILOVER_ORDER)
    .filter((provider) => provider !== primary);
  const fallbacks = fallbackOrder
    .map((provider) => {
      const socketPath = sockets[provider];
      const model = resolveProviderModel(provider, profile, env);
      if (!socketPath || !model) return null;
      return { provider, socketPath, model };
    })
    .filter((target): target is ProviderTurnTarget => target !== null);
  return [...primaryTarget, ...fallbacks];
}

export async function executeProviderTargets<T extends ProviderTurnResult>(
  profile: TurnProfile,
  targets: ProviderTurnTarget[],
  executor: (target: ProviderTurnTarget) => Promise<T>,
  options: {
    sleep?: (ms: number) => Promise<void>;
    onFallback?: (target: ProviderTurnTarget, attempt: number, reason: string, backoffMs: number) => void;
  } = {},
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const cfg = retryConfig(profile);
  let lastResult: T | null = null;

  if (targets.length === 0) {
    throw new Error("provider failover requires at least one target");
  }

  if (targets.length === 1) {
    let backoff = cfg.backoffMs;
    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
      const result = await executor(targets[0]);
      if (result.stop_reason !== "error" && result.stop_reason !== "rate_limited") return result;
      lastResult = result;
      if (attempt < cfg.maxAttempts) {
        options.onFallback?.(targets[0], attempt, result.error ?? result.stop_reason, backoff);
        await sleep(backoff);
        backoff = Math.round(backoff * cfg.backoffMultiplier);
      }
    }
    return lastResult!;
  }

  let backoff = cfg.backoffMs;
  for (let attempt = 1; attempt <= targets.length; attempt += 1) {
    const target = targets[attempt - 1];
    const result = await executor(target);
    if (result.stop_reason !== "error" && result.stop_reason !== "rate_limited") return result;
    lastResult = result;
    if (attempt < targets.length) {
      options.onFallback?.(target, attempt, result.error ?? result.stop_reason, backoff);
      await sleep(backoff);
      backoff = Math.round(backoff * cfg.backoffMultiplier);
    }
  }

  return lastResult!;
}
