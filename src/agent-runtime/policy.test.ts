import { describe, expect, test } from "bun:test";
import { classifySourceGroup, turnProfileConfig } from "./policy";

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

describe("classifySourceGroup", () => {
  test("classifies internal jobs as internal", () => {
    expect(classifySourceGroup("internal_job", "internal")).toBe("internal");
    expect(classifySourceGroup("internal_job", "urgent")).toBe("internal");
  });

  test("classifies mail layers into stable source groups", () => {
    expect(classifySourceGroup("mail_burst", "urgent")).toBe("urgent");
    expect(classifySourceGroup("mail_burst", "private")).toBe("direct");
    expect(classifySourceGroup("mail_burst", "public")).toBe("social");
    expect(classifySourceGroup("mail_burst", "unknown")).toBe("ambient");
  });
});
