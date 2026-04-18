import { describe, expect, test } from "bun:test";
import { resolveLocalDevice } from "./device";

describe("resolveLocalDevice", () => {
  test("defaults embed and rerank workers to cpu", () => {
    expect(resolveLocalDevice("embed", {}).device).toBe("cpu");
    expect(resolveLocalDevice("rerank", {}).device).toBe("cpu");
  });

  test("defaults small and medium workers to the configured GPU device when enabled", () => {
    const env = {
      INFERENCE_LOCAL_GPU_ENABLED: "1",
      INFERENCE_LOCAL_GPU_DEVICE: "cuda",
    };

    expect(resolveLocalDevice("small", env)).toEqual({ device: "cuda", source: "gpu_default" });
    expect(resolveLocalDevice("medium", env)).toEqual({ device: "cuda", source: "gpu_default" });
  });

  test("lets per-worker overrides win over global defaults", () => {
    const env = {
      INFERENCE_LOCAL_GPU_ENABLED: "1",
      INFERENCE_LOCAL_GPU_DEVICE: "cuda",
      INFERENCE_LOCAL_RERANK_DEVICE: "webgpu",
      INFERENCE_LOCAL_DEVICE: "cpu",
    };

    expect(resolveLocalDevice("rerank", env)).toEqual({ device: "webgpu", source: "worker_override" });
  });

  test("uses a global override when present", () => {
    expect(resolveLocalDevice("small", { INFERENCE_LOCAL_DEVICE: "cuda" })).toEqual({
      device: "cuda",
      source: "global_override",
    });
  });
});
