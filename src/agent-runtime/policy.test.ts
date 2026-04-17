import { describe, expect, test } from "bun:test";
import { turnProfileConfig, retryConfig } from "./policy";

describe("turnProfileConfig", () => {
  test("uses global timeout as fallback for every profile", () => {
    const env = {
      FLEET_TURN_TIMEOUT_MS: "45000",
    };

    expect(turnProfileConfig("light", env).timeout_ms).toBe(45_000);
    expect(turnProfileConfig("full", env).timeout_ms).toBe(45_000);
    expect(turnProfileConfig("max", env).timeout_ms).toBe(45_000);
  });

  test("applies per-profile timeout overrides", () => {
    const env = {
      FLEET_TURN_TIMEOUT_MS: "45000",
      FLEET_LIGHT_TIMEOUT_MS: "30000",
      FLEET_FULL_TIMEOUT_MS: "60000",
      FLEET_MAX_TIMEOUT_MS: "90000",
    };

    expect(turnProfileConfig("light", env).timeout_ms).toBe(30_000);
    expect(turnProfileConfig("full", env).timeout_ms).toBe(60_000);
    expect(turnProfileConfig("max", env).timeout_ms).toBe(90_000);
  });

  test("clamps too-small timeout overrides to the safety floor", () => {
    const env = {
      FLEET_TURN_TIMEOUT_MS: "10000",
      FLEET_LIGHT_TIMEOUT_MS: "1",
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
