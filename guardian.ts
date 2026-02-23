#!/usr/bin/env bun

import { readFileSync, existsSync } from "fs";
import { parse } from "yaml";
import { logInfo, logWarn, logError } from "./lib/logger";
import { checkBeeHealth } from "./lib/bee";
import { pingHealthcheck, type CooldownConfig, type TelegramConfig } from "./lib/alert";
import { loadState, saveState, freshState, type GuardianState } from "./lib/state";
import { checkStamps, type StampConfig } from "./checks/stamps";
import { checkBalances, type BalancesConfig } from "./checks/balances";

// ── Config types ────────────────────────────────────────

interface GuardianConfig {
  bee_url: string;
  healthcheck: {
    ping_url_env: string;
  };
  alerts: {
    telegram_bot_token_env: string;
    telegram_chat_id_env: string;
    cooldown: CooldownConfig;
  };
  stamps: StampConfig;
  balances: BalancesConfig;
  state_file: string;
}

// ── Main ────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

async function main(): Promise<void> {
  if (dryRun) {
    logInfo("mode", { dry_run: true });
  }

  // 0. Load and validate config
  const configPath =
    process.env.GUARDIAN_CONFIG || "./guardian.yaml";

  if (!existsSync(configPath)) {
    logError("config_missing", { path: configPath });
    console.error(
      `Error: Config not found at ${configPath}. Set GUARDIAN_CONFIG or create guardian.yaml.`
    );
    process.exit(1);
  }

  let config: GuardianConfig;
  try {
    const raw = readFileSync(configPath, "utf-8");
    config = parse(raw) as GuardianConfig;
  } catch (e) {
    logError("config_parse_error", {
      error: e instanceof Error ? e.message : String(e),
    });
    process.exit(1);
  }

  // Validate required env vars
  const botToken = process.env[config.alerts.telegram_bot_token_env];
  const chatId = process.env[config.alerts.telegram_chat_id_env];
  if (!botToken || !chatId) {
    const missing = !botToken ? config.alerts.telegram_bot_token_env : config.alerts.telegram_chat_id_env;
    logError("missing_env", { var: missing });
    console.error(`Error: ${missing} not set.`);
    process.exit(1);
  }
  const telegram: TelegramConfig = { botToken, chatId };

  const healthcheckUrl = process.env[config.healthcheck.ping_url_env];

  // Validate Bee URL is localhost
  const beeUrl = config.bee_url;
  if (
    !beeUrl.startsWith("http://localhost") &&
    !beeUrl.startsWith("http://127.0.0.1")
  ) {
    logError("bee_url_not_local", { bee_url: beeUrl });
    console.error(
      "Error: Bee URL must be localhost or 127.0.0.1 for safety."
    );
    process.exit(1);
  }

  // Validate Bee is reachable
  const beeHealthy = await checkBeeHealth(beeUrl);
  if (!beeHealthy) {
    logError("bee_unreachable", { bee_url: beeUrl });
    console.error(
      `Error: Cannot reach Bee node at ${beeUrl}. Is it running?`
    );
    process.exit(1);
  }

  logInfo("startup", {
    config: configPath,
    bee_url: beeUrl,
    dry_run: dryRun,
    stamps: config.stamps.allowed_ids.length,
    balances: config.balances.entries.length,
  });

  // 1. Load state
  const state = loadState(config.state_file);
  let hasCritical = false;

  // 2. Stamp checks
  try {
    const stampResult = await checkStamps(
      beeUrl,
      config.stamps,
      state,
      telegram,
      config.alerts.cooldown,
      dryRun
    );
    if (stampResult.hasCritical) hasCritical = true;
  } catch (e) {
    logError("stamp_check_error", {
      error: e instanceof Error ? e.message : String(e),
    });
    hasCritical = true;
  }

  // 3. Balance checks
  try {
    const balanceResult = await checkBalances(
      config.balances,
      state,
      telegram,
      config.alerts.cooldown,
      dryRun
    );
    if (balanceResult.hasCritical) hasCritical = true;
  } catch (e) {
    logError("balance_check_error", {
      error: e instanceof Error ? e.message : String(e),
    });
    hasCritical = true;
  }

  // 4. Save state
  if (!dryRun) {
    try {
      saveState(config.state_file, state);
    } catch (e) {
      logError("state_save_error", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  } else {
    logInfo("state_dry_run", { action: "skip_save" });
  }

  // 5. Healthcheck ping
  if (healthcheckUrl) {
    await pingHealthcheck(healthcheckUrl, dryRun);
  }

  logInfo("run_complete", {
    has_critical: hasCritical,
    dry_run: dryRun,
  });

  process.exit(hasCritical ? 1 : 0);
}

main().catch((e) => {
  logError("fatal", {
    error: e instanceof Error ? e.message : String(e),
  });
  process.exit(1);
});
