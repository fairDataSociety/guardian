import { logInfo, logWarn, logError } from "./logger";
import type { GuardianState } from "./state";

export type AlertLevel = "info" | "warn" | "critical";

interface AlertField {
  name: string;
  value: string;
  inline?: boolean;
}

const LEVEL_COLORS: Record<AlertLevel, number> = {
  info: 3066993,     // green
  warn: 16776960,    // yellow
  critical: 16711680, // red
};

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(h|m|d)$/);
  if (!match) return 86400000; // default 24h
  const [, num, unit] = match;
  const ms = { h: 3600000, m: 60000, d: 86400000 }[unit] || 3600000;
  return parseInt(num) * ms;
}

export interface CooldownConfig {
  warn: string;
  critical: string;
  info: string;
}

export function shouldAlert(
  state: GuardianState,
  key: string,
  level: AlertLevel,
  cooldowns: CooldownConfig
): boolean {
  const lastSent = state.alerts_sent[key];
  if (!lastSent) return true;

  const cooldownMs = parseDuration(cooldowns[level]);
  const elapsed = Date.now() - new Date(lastSent).getTime();
  return elapsed >= cooldownMs;
}

export async function sendAlert(
  webhookUrl: string,
  level: AlertLevel,
  check: string,
  target: string,
  details: string,
  dryRun: boolean = false
): Promise<boolean> {
  const payload = {
    embeds: [
      {
        title: `Guardian: ${level.toUpperCase()}`,
        color: LEVEL_COLORS[level],
        fields: [
          { name: "Check", value: check, inline: true },
          { name: "Target", value: target, inline: true },
          { name: "Details", value: details },
        ] as AlertField[],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  if (dryRun) {
    logInfo("alert_dry_run", {
      level,
      check,
      target,
      details,
    });
    return true;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      if (resp.ok || resp.status === 204) {
        logInfo("alert_sent", { level, check, target });
        return true;
      }

      logWarn("alert_retry", {
        attempt: attempt + 1,
        status: resp.status,
      });
    } catch (e) {
      logWarn("alert_retry", {
        attempt: attempt + 1,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }

  logError("alert_failed", { level, check, target });
  return false;
}

export async function pingHealthcheck(
  url: string,
  dryRun: boolean = false
): Promise<void> {
  if (dryRun) {
    logInfo("healthcheck_dry_run", { url: url.slice(0, 20) + "..." });
    return;
  }

  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });
    logInfo("healthcheck_ping", {
      status: resp.ok ? "ok" : "failed",
    });
  } catch (e) {
    logWarn("healthcheck_ping_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    // Don't fail the run - dead man's switch will detect missing ping
  }
}
