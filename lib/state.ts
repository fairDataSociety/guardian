import {
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  existsSync,
} from "fs";
import { logInfo, logWarn, logError } from "./logger";

const STATE_VERSION = 1;
const ALERTS_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 30 days

export interface StampState {
  ttl_days: number;
  last_topup?: string;
  last_topup_amount_bzz?: number;
}

export interface GuardianState {
  version: number;
  last_run: string;
  stamps: Record<string, StampState>;
  daily_spend_bzz: number;
  daily_spend_reset: string;
  alerts_sent: Record<string, string>;
}

export function freshState(): GuardianState {
  return {
    version: STATE_VERSION,
    last_run: new Date().toISOString(),
    stamps: {},
    daily_spend_bzz: 0,
    daily_spend_reset: new Date().toISOString(),
    alerts_sent: {},
  };
}

export function loadState(path: string): GuardianState {
  if (!existsSync(path)) {
    logWarn("state_missing", { path, action: "starting_fresh" });
    return freshState();
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const state = JSON.parse(raw) as GuardianState;

    if (state.version !== STATE_VERSION) {
      logWarn("state_version_mismatch", {
        expected: STATE_VERSION,
        found: state.version,
        action: "starting_fresh",
      });
      return freshState();
    }

    // Reset daily spend if >24h
    const resetTime = new Date(state.daily_spend_reset).getTime();
    if (Date.now() - resetTime > 24 * 3600 * 1000) {
      state.daily_spend_bzz = 0;
      state.daily_spend_reset = new Date().toISOString();
    }

    // Prune old alert entries
    const cutoff = Date.now() - ALERTS_MAX_AGE_MS;
    for (const [key, ts] of Object.entries(state.alerts_sent)) {
      if (new Date(ts).getTime() < cutoff) {
        delete state.alerts_sent[key];
      }
    }

    return state;
  } catch (e) {
    logWarn("state_corrupt", {
      path,
      error: e instanceof Error ? e.message : String(e),
      action: "starting_fresh",
    });
    return freshState();
  }
}

export function saveState(path: string, state: GuardianState): void {
  state.last_run = new Date().toISOString();

  // Backup before write
  if (existsSync(path)) {
    try {
      copyFileSync(path, path + ".bak");
    } catch (e) {
      logWarn("state_backup_failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Atomic write: write tmp, then rename
  const tmpPath = path + ".tmp";
  try {
    writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, path);
    logInfo("state_saved", { path });
  } catch (e) {
    logError("state_save_failed", {
      path,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

export function recordTopup(
  state: GuardianState,
  stampId: string,
  amountBzz: number
): void {
  state.stamps[stampId] = {
    ...state.stamps[stampId],
    ttl_days: state.stamps[stampId]?.ttl_days || 0,
    last_topup: new Date().toISOString(),
    last_topup_amount_bzz: amountBzz,
  };
  state.daily_spend_bzz += amountBzz;
}

export function recordAlert(
  state: GuardianState,
  key: string
): void {
  state.alerts_sent[key] = new Date().toISOString();
}

export function canTopup(
  state: GuardianState,
  stampId: string,
  amountBzz: number,
  maxDailyBzz: number
): { allowed: boolean; reason?: string } {
  // Check daily spend
  if (state.daily_spend_bzz + amountBzz > maxDailyBzz) {
    return {
      allowed: false,
      reason: `Daily spend limit would be exceeded (${state.daily_spend_bzz + amountBzz} > ${maxDailyBzz} BZZ)`,
    };
  }

  // Check last topup for this stamp was >1h ago
  const stampState = state.stamps[stampId];
  if (stampState?.last_topup) {
    const elapsed = Date.now() - new Date(stampState.last_topup).getTime();
    if (elapsed < 3600000) {
      return {
        allowed: false,
        reason: `Last topup was ${Math.round(elapsed / 60000)} minutes ago (min 60 minutes)`,
      };
    }
  }

  return { allowed: true };
}
