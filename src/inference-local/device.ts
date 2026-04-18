export type LocalWorkerKind = "small" | "medium" | "embed" | "rerank";

export type LocalDeviceConfig = {
  device: string;
  source: "worker_override" | "global_override" | "gpu_default" | "cpu_default";
};

function parseTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function envKey(kind: LocalWorkerKind, suffix: string): string {
  return `INFERENCE_LOCAL_${kind.toUpperCase()}_${suffix}`;
}

export function resolveLocalDevice(kind: LocalWorkerKind, env: Record<string, string | undefined> = process.env): LocalDeviceConfig {
  const workerOverride = env[envKey(kind, "DEVICE")]?.trim();
  if (workerOverride) return { device: workerOverride, source: "worker_override" };

  const globalOverride = env.INFERENCE_LOCAL_DEVICE?.trim();
  if (globalOverride) return { device: globalOverride, source: "global_override" };

  const gpuPreferred = parseTruthy(env.INFERENCE_LOCAL_GPU_ENABLED);
  const gpuDevice = env.INFERENCE_LOCAL_GPU_DEVICE?.trim() || "webgpu";
  if ((kind === "small" || kind === "medium") && gpuPreferred) {
    return { device: gpuDevice, source: "gpu_default" };
  }

  return { device: "cpu", source: "cpu_default" };
}
