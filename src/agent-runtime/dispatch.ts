export interface DispatchOptions {
  maxConsecutiveErrors?: number;
  baseBackoffMs?: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
  onError?: (error: unknown, consecutiveErrors: number) => void;
  onFatal?: (error: unknown, consecutiveErrors: number) => void;
}

export interface DispatchCallbacks {
  selectWake: () => Promise<unknown>;
  processWake: (wake: unknown) => Promise<void>;
  shouldContinue?: () => boolean;
}

export interface DispatchResult {
  reason: "exhausted" | "stopped" | "fatal";
  consecutiveErrors: number;
  totalIterations: number;
}

export async function runDispatchLoop(
  callbacks: DispatchCallbacks,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const {
    maxConsecutiveErrors = 5,
    baseBackoffMs = 1_000,
    backoffMultiplier = 2.0,
    maxBackoffMs = 30_000,
    onError,
    onFatal,
  } = options;

  let consecutiveErrors = 0;
  let totalIterations = 0;
  let currentBackoffMs = baseBackoffMs;

  while (true) {
    if (callbacks.shouldContinue && !callbacks.shouldContinue()) {
      return { reason: "stopped", consecutiveErrors, totalIterations };
    }

    try {
      const wake = await callbacks.selectWake();
      if (wake !== null && wake !== undefined) {
        await callbacks.processWake(wake);
      }
      consecutiveErrors = 0;
      currentBackoffMs = baseBackoffMs;
      totalIterations++;
    } catch (error) {
      consecutiveErrors++;
      totalIterations++;

      if (consecutiveErrors >= maxConsecutiveErrors) {
        onFatal?.(error, consecutiveErrors);
        return { reason: "fatal", consecutiveErrors, totalIterations };
      }

      onError?.(error, consecutiveErrors);
      await new Promise((resolve) => setTimeout(resolve, currentBackoffMs));
      currentBackoffMs = Math.min(Math.round(currentBackoffMs * backoffMultiplier), maxBackoffMs);
    }
  }
}
