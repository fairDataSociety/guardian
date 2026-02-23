import { fetchStamp, topupStamp, fetchChainState, calcTopupAmount, ttlDays, type StampInfo } from "../lib/bee";
import {
  sendAlert,
  shouldAlert,
  type AlertLevel,
  type CooldownConfig,
  type TelegramConfig,
} from "../lib/alert";
import {
  type GuardianState,
  recordTopup,
  recordAlert,
  canTopup,
} from "../lib/state";
import { logInfo, logWarn, logError } from "../lib/logger";

export interface StampConfig {
  warn_days: number;
  critical_days: number;
  auto_topup: boolean;
  max_topup_bzz: number;
  max_daily_spend_bzz: number;
  max_topups_per_run: number;
  allowed_ids: Array<{ id: string; name: string }>;
}

interface CheckResult {
  hasCritical: boolean;
}

export async function checkStamps(
  beeUrl: string,
  config: StampConfig,
  state: GuardianState,
  telegram: TelegramConfig,
  cooldowns: CooldownConfig,
  dryRun: boolean
): Promise<CheckResult> {
  let hasCritical = false;
  let topupsThisRun = 0;

  for (const entry of config.allowed_ids) {
    const label = entry.name;
    const shortId = entry.id.slice(0, 8) + "...";

    let stamp: StampInfo;
    try {
      stamp = await fetchStamp(beeUrl, entry.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError("stamp_fetch_failed", { stamp: label, error: msg });

      const alertKey = `stamp:${entry.id.slice(0, 8)}:unreachable`;
      if (shouldAlert(state, alertKey, "critical", cooldowns)) {
        await sendAlert(
          telegram,
          "critical",
          "Stamp Unreachable",
          label,
          `Cannot fetch stamp ${shortId}: ${msg}`,
          dryRun
        );
        recordAlert(state, alertKey);
      }
      hasCritical = true;
      continue;
    }

    const days = ttlDays(stamp.batchTTL);

    // Update state
    state.stamps[entry.id] = {
      ...state.stamps[entry.id],
      ttl_days: Math.round(days),
    };

    if (days < config.critical_days) {
      // CRITICAL
      logWarn("stamp_critical", {
        stamp: label,
        ttl_days: Math.round(days),
        threshold: config.critical_days,
      });

      const alertKey = `stamp:${entry.id.slice(0, 8)}:critical`;
      if (shouldAlert(state, alertKey, "critical", cooldowns)) {
        await sendAlert(
          telegram,
          "critical",
          "Stamp TTL Critical",
          label,
          `${Math.round(days)} days remaining (threshold: ${config.critical_days})`,
          dryRun
        );
        recordAlert(state, alertKey);
      }
      hasCritical = true;
    } else if (days < config.warn_days) {
      // WARN - attempt auto-topup
      logWarn("stamp_low", {
        stamp: label,
        ttl_days: Math.round(days),
        threshold: config.warn_days,
      });

      if (
        config.auto_topup &&
        topupsThisRun < config.max_topups_per_run
      ) {
        await attemptTopup(
          beeUrl,
          entry,
          stamp,
          config,
          state,
          telegram,
          cooldowns,
          dryRun
        );
        topupsThisRun++;
      } else {
        const alertKey = `stamp:${entry.id.slice(0, 8)}:warn`;
        if (shouldAlert(state, alertKey, "warn", cooldowns)) {
          await sendAlert(
            telegram,
            "warn",
            "Stamp TTL Low",
            label,
            `${Math.round(days)} days remaining (threshold: ${config.warn_days})`,
            dryRun
          );
          recordAlert(state, alertKey);
        }
      }
    } else {
      // OK
      logInfo("stamp_check", {
        stamp: label,
        ttl_days: Math.round(days),
        action: "skip",
      });
    }
  }

  return { hasCritical };
}

async function attemptTopup(
  beeUrl: string,
  entry: { id: string; name: string },
  stamp: StampInfo,
  config: StampConfig,
  state: GuardianState,
  telegram: string,
  cooldowns: CooldownConfig,
  dryRun: boolean
): Promise<void> {
  const label = entry.name;
  const currentDays = ttlDays(stamp.batchTTL);
  const targetDays = config.warn_days * 2;
  const extraDays = targetDays - currentDays;

  // Fetch current postage price from Bee
  let currentPrice: bigint;
  try {
    const chainState = await fetchChainState(beeUrl);
    currentPrice = BigInt(chainState.currentPrice);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError("chainstate_fetch_failed", { error: msg });
    return;
  }

  // Calculate per-chunk amount to add for the desired extra days
  const topupAmount = calcTopupAmount(extraDays, currentPrice);

  // Estimate total BZZ cost: amount * 2^depth / 10^16
  const totalPlur = topupAmount * BigInt(2 ** stamp.depth);
  const estimatedBzz = Number(totalPlur) / 1e16;

  // Check circuit breaker
  const check = canTopup(
    state,
    entry.id,
    estimatedBzz,
    config.max_daily_spend_bzz
  );
  if (!check.allowed) {
    logWarn("topup_blocked", {
      stamp: label,
      reason: check.reason,
    });
    const alertKey = `stamp:${entry.id.slice(0, 8)}:topup_blocked`;
    if (shouldAlert(state, alertKey, "warn", cooldowns)) {
      await sendAlert(
        telegram,
        "warn",
        "Topup Blocked",
        label,
        check.reason!,
        dryRun
      );
      recordAlert(state, alertKey);
    }
    return;
  }

  // Cap per-chunk amount to max_topup_bzz equivalent
  const maxAmount = BigInt(config.max_topup_bzz) * BigInt(10 ** 16) / BigInt(2 ** stamp.depth);
  const cappedAmount = topupAmount < maxAmount ? topupAmount : maxAmount;

  logInfo("topup_attempt", {
    stamp: label,
    per_chunk_amount: cappedAmount.toString(),
    estimated_bzz: Math.round(estimatedBzz * 100) / 100,
    current_ttl_days: Math.round(currentDays),
    target_ttl_days: targetDays,
    current_price: currentPrice.toString(),
  });

  if (dryRun) {
    logInfo("topup_dry_run", {
      stamp: label,
      per_chunk_amount: cappedAmount.toString(),
      estimated_bzz: Math.round(estimatedBzz * 100) / 100,
    });
    return;
  }

  try {
    const batchId = await topupStamp(beeUrl, entry.id, cappedAmount);
    recordTopup(state, entry.id, estimatedBzz);

    logInfo("topup_success", {
      stamp: label,
      amount_bzz: topupBzz,
      batch_id: batchId.slice(0, 8) + "...",
    });

    const alertKey = `stamp:${entry.id.slice(0, 8)}:topup_success`;
    if (shouldAlert(state, alertKey, "info", cooldowns)) {
      await sendAlert(
        telegram,
        "info",
        "Stamp Topped Up",
        label,
        `Added ~${Math.round(estimatedBzz * 100) / 100} BZZ (was ${Math.round(currentDays)} days TTL)`,
        dryRun
      );
      recordAlert(state, alertKey);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError("topup_failed", { stamp: label, error: msg });

    const alertKey = `stamp:${entry.id.slice(0, 8)}:topup_failed`;
    await sendAlert(
      telegram,
      "critical",
      "Topup Failed",
      label,
      msg,
      dryRun
    );
    recordAlert(state, alertKey);
  }
}
