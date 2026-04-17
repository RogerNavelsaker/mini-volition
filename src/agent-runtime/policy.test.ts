import { describe, expect, test } from "bun:test";
import { turnProfileConfig } from "./policy";

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
