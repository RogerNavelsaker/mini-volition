import { describe, expect, test } from "bun:test";
import { turnProfileConfig, retryConfig, clampTurnProfile, chooseTurnProfileWithBounds } from "./policy";

describe("turnProfileConfig", () => {
  test("uses global timeout as fallback for every profile", () => {
    const env = {
      INFERENCE_TURN_TIMEOUT_MS: "45000",
    };

    expect(turnProfileConfig("light", env).timeout_ms).toBe(45_000);
    expect(turnProfileConfig("full", env).timeout_ms).toBe(45_000);
    expect(turnProfileConfig("max", env).timeout_ms).toBe(45_000);
  });

  test("applies per-profile timeout overrides", () => {
    const env = {
      INFERENCE_TURN_TIMEOUT_MS: "45000",
      INFERENCE_LOCAL_SMALL_TIMEOUT_MS: "30000",
      INFERENCE_CLOUD_TIMEOUT_MS: "60000",
      INFERENCE_CLOUD_MAX_TIMEOUT_MS: "90000",
    };

    expect(turnProfileConfig("light", env).timeout_ms).toBe(30_000);
    expect(turnProfileConfig("full", env).timeout_ms).toBe(60_000);
    expect(turnProfileConfig("max", env).timeout_ms).toBe(90_000);
  });

  test("clamps too-small timeout overrides to the safety floor", () => {
    const env = {
      INFERENCE_TURN_TIMEOUT_MS: "10000",
      INFERENCE_LOCAL_SMALL_TIMEOUT_MS: "1",
    };

    expect(turnProfileConfig("light", env).timeout_ms).toBe(15_000);
    expect(turnProfileConfig("full", env).timeout_ms).toBe(15_000);
  });
});

describe("retryConfig", () => {
  test("light: 2 attempts, 1000ms base, 1.5x multiplier", () => {
    const cfg = retryConfig("light");
    expect(cfg.maxAttempts).toBe(2);
    expect(cfg.backoffMs).toBe(1_000);
    expect(cfg.backoffMultiplier).toBe(1.5);
  });

  test("full: 3 attempts, 2000ms base, 2x multiplier", () => {
    const cfg = retryConfig("full");
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.backoffMs).toBe(2_000);
    expect(cfg.backoffMultiplier).toBe(2.0);
  });

  test("max: 4 attempts, 3000ms base, 2x multiplier", () => {
    const cfg = retryConfig("max");
    expect(cfg.maxAttempts).toBe(4);
    expect(cfg.backoffMs).toBe(3_000);
    expect(cfg.backoffMultiplier).toBe(2.0);
  });

  test("attempt counts strictly increase: light < full < max", () => {
    expect(retryConfig("light").maxAttempts).toBeLessThan(retryConfig("full").maxAttempts);
    expect(retryConfig("full").maxAttempts).toBeLessThan(retryConfig("max").maxAttempts);
  });

  test("backoff increases with profile weight", () => {
    expect(retryConfig("light").backoffMs).toBeLessThan(retryConfig("full").backoffMs);
    expect(retryConfig("full").backoffMs).toBeLessThan(retryConfig("max").backoffMs);
  });
});

describe("clampTurnProfile", () => {
  test("returns profile unchanged when within floor and ceiling", () => {
    expect(clampTurnProfile("full", "light", "max")).toBe("full");
  });

  test("raises profile to floor when below floor", () => {
    expect(clampTurnProfile("light", "full", "max")).toBe("full");
  });

  test("lowers profile to ceiling when above ceiling", () => {
    expect(clampTurnProfile("max", "light", "full")).toBe("full");
  });

  test("returns floor when floor equals ceiling", () => {
    expect(clampTurnProfile("light", "full", "full")).toBe("full");
    expect(clampTurnProfile("max", "full", "full")).toBe("full");
  });

  test("defaults floor=light, ceiling=max (no clamping)", () => {
    expect(clampTurnProfile("light")).toBe("light");
    expect(clampTurnProfile("full")).toBe("full");
    expect(clampTurnProfile("max")).toBe("max");
  });

  test("clamps light→full when floor=full", () => {
    expect(clampTurnProfile("light", "full")).toBe("full");
  });

  test("clamps max→light when ceiling=light", () => {
    expect(clampTurnProfile("max", "light", "light")).toBe("light");
  });
});

describe("chooseTurnProfileWithBounds", () => {
  const internalJob: "internal_job" = "internal_job";
  const urgentBurst = { primary: { layer: "urgent" }, messages: [{ body: "critical outage" }] };
  const lightBurst = { primary: { layer: "public" }, messages: [{ body: "fyi receipt acknowledged" }] };
  const normalBurst = { primary: { layer: "public" }, messages: [{ body: "please review" }] };

  test("chooseTurnProfile selects max for urgent; ceiling=full clamps to full", () => {
    const result = chooseTurnProfileWithBounds(internalJob, urgentBurst, "light", "full");
    expect(result).toBe("full");
  });

  test("chooseTurnProfile selects light; floor=full raises to full", () => {
    const result = chooseTurnProfileWithBounds("mail_burst", lightBurst, "full", "max");
    expect(result).toBe("full");
  });

  test("no bounds applied when floor=light, ceiling=max", () => {
    const light = chooseTurnProfileWithBounds("mail_burst", lightBurst, "light", "max");
    expect(light).toBe("light");
  });

  test("preserves full when no clamping needed", () => {
    const result = chooseTurnProfileWithBounds("mail_burst", normalBurst, "light", "max");
    expect(result).toBe("full");
  });
});
