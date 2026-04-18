export type EscalationSeverity = "low" | "normal" | "high" | "critical";

export type EscalationRoute = {
  severity: EscalationSeverity;
  channel: string;
  layer: "private" | "public" | "urgent";
  notify: boolean;
  reason: string;
};

export type EscalationConfig = {
  operator_channel?: string;
  alert_channel?: string;
  default_channel?: string;
};

const DEFAULT_ROUTES: Record<EscalationSeverity, Omit<EscalationRoute, "severity">> = {
  low: {
    channel: "escalations:low",
    layer: "private",
    notify: false,
    reason: "low-severity: recorded, no notification required",
  },
  normal: {
    channel: "escalations:normal",
    layer: "private",
    notify: false,
    reason: "normal-severity: recorded, no notification required",
  },
  high: {
    channel: "escalations:high",
    layer: "public",
    notify: true,
    reason: "high-severity: operator notification required",
  },
  critical: {
    channel: "escalations:critical",
    layer: "urgent",
    notify: true,
    reason: "critical-severity: immediate operator response required",
  },
};

const SEVERITY_RANK: Record<EscalationSeverity, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

export function routeEscalation(
  severity: EscalationSeverity,
  config: EscalationConfig = {},
): EscalationRoute {
  const defaults = DEFAULT_ROUTES[severity];
  const channel = severity === "critical"
    ? (config.alert_channel ?? config.operator_channel ?? defaults.channel)
    : severity === "high"
      ? (config.operator_channel ?? defaults.channel)
      : (config.default_channel ?? defaults.channel);
  return { severity, ...defaults, channel };
}

export function normalizeSeverity(value: unknown): EscalationSeverity {
  if (value === "low" || value === "normal" || value === "high" || value === "critical") {
    return value;
  }
  return "normal";
}

export function compareSeverity(a: EscalationSeverity, b: EscalationSeverity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

export function maxSeverity(severities: EscalationSeverity[]): EscalationSeverity | null {
  if (severities.length === 0) return null;
  return severities.reduce((max, s) => compareSeverity(s, max) > 0 ? s : max, "low" as EscalationSeverity);
}

export function requiresNotification(severity: EscalationSeverity): boolean {
  return DEFAULT_ROUTES[severity].notify;
}

export function requiresUrgentLayer(severity: EscalationSeverity): boolean {
  return DEFAULT_ROUTES[severity].layer === "urgent";
}
