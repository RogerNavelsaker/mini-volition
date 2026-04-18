import { describe, it, expect } from "bun:test";
import {
  routeEscalation,
  normalizeSeverity,
  compareSeverity,
  maxSeverity,
  requiresNotification,
  requiresUrgentLayer,
} from "./escalation";
import type { EscalationSeverity } from "./escalation";

describe("routeEscalation — default routing", () => {
  it("routes low to private layer without notification", () => {
    const route = routeEscalation("low");
    expect(route.layer).toBe("private");
    expect(route.notify).toBe(false);
    expect(route.severity).toBe("low");
  });

  it("routes normal to private layer without notification", () => {
    const route = routeEscalation("normal");
    expect(route.layer).toBe("private");
    expect(route.notify).toBe(false);
  });

  it("routes high to public layer with notification", () => {
    const route = routeEscalation("high");
    expect(route.layer).toBe("public");
    expect(route.notify).toBe(true);
  });

  it("routes critical to urgent layer with notification", () => {
    const route = routeEscalation("critical");
    expect(route.layer).toBe("urgent");
    expect(route.notify).toBe(true);
  });

  it("returns a channel for each severity", () => {
    for (const severity of ["low", "normal", "high", "critical"] as EscalationSeverity[]) {
      const route = routeEscalation(severity);
      expect(route.channel.length).toBeGreaterThan(0);
    }
  });

  it("returns a reason for each severity", () => {
    for (const severity of ["low", "normal", "high", "critical"] as EscalationSeverity[]) {
      expect(routeEscalation(severity).reason.length).toBeGreaterThan(0);
    }
  });
});

describe("routeEscalation — config overrides", () => {
  it("uses operator_channel for high severity", () => {
    const route = routeEscalation("high", { operator_channel: "ops:alerts" });
    expect(route.channel).toBe("ops:alerts");
  });

  it("uses alert_channel for critical severity", () => {
    const route = routeEscalation("critical", { alert_channel: "ops:pagerduty" });
    expect(route.channel).toBe("ops:pagerduty");
  });

  it("falls back to operator_channel for critical when no alert_channel", () => {
    const route = routeEscalation("critical", { operator_channel: "ops:alerts" });
    expect(route.channel).toBe("ops:alerts");
  });

  it("uses default_channel for low/normal", () => {
    const low = routeEscalation("low", { default_channel: "my:escalations" });
    expect(low.channel).toBe("my:escalations");
    const normal = routeEscalation("normal", { default_channel: "my:escalations" });
    expect(normal.channel).toBe("my:escalations");
  });

  it("config does not override layer or notify", () => {
    const route = routeEscalation("low", { operator_channel: "ops" });
    expect(route.layer).toBe("private");
    expect(route.notify).toBe(false);
  });
});

describe("normalizeSeverity", () => {
  it("returns valid severity unchanged", () => {
    for (const s of ["low", "normal", "high", "critical"]) {
      expect(normalizeSeverity(s)).toBe(s);
    }
  });

  it("defaults unknown values to normal", () => {
    expect(normalizeSeverity("fatal")).toBe("normal");
    expect(normalizeSeverity(null)).toBe("normal");
    expect(normalizeSeverity(undefined)).toBe("normal");
    expect(normalizeSeverity(42)).toBe("normal");
  });
});

describe("compareSeverity", () => {
  it("returns 0 for equal severities", () => {
    expect(compareSeverity("high", "high")).toBe(0);
  });

  it("returns negative when a < b", () => {
    expect(compareSeverity("low", "high")).toBeLessThan(0);
    expect(compareSeverity("normal", "critical")).toBeLessThan(0);
  });

  it("returns positive when a > b", () => {
    expect(compareSeverity("critical", "low")).toBeGreaterThan(0);
    expect(compareSeverity("high", "normal")).toBeGreaterThan(0);
  });

  it("establishes full ordering: low < normal < high < critical", () => {
    const order: EscalationSeverity[] = ["low", "normal", "high", "critical"];
    for (let i = 0; i < order.length - 1; i++) {
      expect(compareSeverity(order[i], order[i + 1])).toBeLessThan(0);
    }
  });
});

describe("maxSeverity", () => {
  it("returns null for empty list", () => {
    expect(maxSeverity([])).toBeNull();
  });

  it("returns the only element for single-item list", () => {
    expect(maxSeverity(["high"])).toBe("high");
  });

  it("returns the highest severity", () => {
    expect(maxSeverity(["low", "critical", "normal"])).toBe("critical");
    expect(maxSeverity(["high", "normal", "low"])).toBe("high");
  });

  it("returns highest from duplicates", () => {
    expect(maxSeverity(["low", "low", "normal"])).toBe("normal");
  });
});

describe("requiresNotification / requiresUrgentLayer", () => {
  it("only high and critical require notification", () => {
    expect(requiresNotification("low")).toBe(false);
    expect(requiresNotification("normal")).toBe(false);
    expect(requiresNotification("high")).toBe(true);
    expect(requiresNotification("critical")).toBe(true);
  });

  it("only critical requires urgent layer", () => {
    expect(requiresUrgentLayer("low")).toBe(false);
    expect(requiresUrgentLayer("normal")).toBe(false);
    expect(requiresUrgentLayer("high")).toBe(false);
    expect(requiresUrgentLayer("critical")).toBe(true);
  });
});
