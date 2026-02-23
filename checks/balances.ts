import { ethers, formatUnits, parseUnits, Contract } from "ethers";
import {
  type ChainConfig,
  type TokenConfig,
  getProvider,
  withTimeout,
  nativeTokenName,
  ERC20_ABI,
} from "../lib/chains";
import {
  sendAlert,
  shouldAlert,
  type AlertLevel,
  type CooldownConfig,
  type TelegramConfig,
} from "../lib/alert";
import { type GuardianState, recordAlert } from "../lib/state";
import { logInfo, logWarn, logError } from "../lib/logger";

export interface BalanceCheck {
  token: string;
  warn: string;
  critical: string;
}

export interface BalanceEntry {
  name: string;
  address: string;
  chain: string;
  checks: BalanceCheck[];
}

export interface BalancesConfig {
  chains: Record<string, ChainConfig>;
  tokens: Record<string, TokenConfig>;
  entries: BalanceEntry[];
}

interface CheckResult {
  hasCritical: boolean;
}

export async function checkBalances(
  config: BalancesConfig,
  state: GuardianState,
  telegram: TelegramConfig,
  cooldowns: CooldownConfig,
  dryRun: boolean
): Promise<CheckResult> {
  let hasCritical = false;

  for (const entry of config.entries) {
    const chain = config.chains[entry.chain];
    if (!chain) {
      logError("unknown_chain", { chain: entry.chain, account: entry.name });
      continue;
    }

    for (const check of entry.checks) {
      let balance: bigint;
      let decimals = 18;
      let tokenLabel: string;

      const provider = getProvider(chain);

      // Retry logic with backoff
      let lastError: Error | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (check.token === "native" || check.token === "eth") {
            balance = await withTimeout(
              provider.getBalance(entry.address)
            );
            tokenLabel = nativeTokenName(chain.id);
          } else {
            const tokenDef = config.tokens[check.token];
            if (!tokenDef) {
              logError("unknown_token", {
                token: check.token,
                account: entry.name,
              });
              break;
            }
            const contract = new Contract(
              tokenDef.address,
              ERC20_ABI,
              provider
            );
            balance = await withTimeout(contract.balanceOf(entry.address));
            decimals = tokenDef.decimals;
            tokenLabel = check.token.toUpperCase();
          }

          // Success - evaluate thresholds
          const criticalVal = parseUnits(check.critical, decimals);
          const warnVal = parseUnits(check.warn, decimals);
          const balStr = formatUnits(balance!, decimals);

          if (balance! < criticalVal) {
            logWarn("balance_critical", {
              account: entry.name,
              chain: entry.chain,
              token: check.token,
              balance: balStr,
              threshold: check.critical,
            });

            const alertKey = `balance:${entry.name}:${check.token}:critical`;
            if (shouldAlert(state, alertKey, "critical", cooldowns)) {
              await sendAlert(
                telegram,
                "critical",
                "Balance Critical",
                entry.name,
                `${tokenLabel!} below critical threshold (${check.critical})`,
                dryRun
              );
              recordAlert(state, alertKey);
            }
            hasCritical = true;
          } else if (balance! < warnVal) {
            logWarn("balance_low", {
              account: entry.name,
              chain: entry.chain,
              token: check.token,
              balance: balStr,
              threshold: check.warn,
            });

            const alertKey = `balance:${entry.name}:${check.token}:warn`;
            if (shouldAlert(state, alertKey, "warn", cooldowns)) {
              await sendAlert(
                telegram,
                "warn",
                "Balance Low",
                entry.name,
                `${tokenLabel!} below warn threshold (${check.warn})`,
                dryRun
              );
              recordAlert(state, alertKey);
            }
          } else {
            logInfo("balance_ok", {
              account: entry.name,
              chain: entry.chain,
              token: check.token,
            });
          }

          lastError = undefined;
          break; // success, no retry
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          if (attempt < 2) {
            logWarn("balance_retry", {
              account: entry.name,
              chain: entry.chain,
              attempt: attempt + 1,
              error: lastError.message,
            });
            await new Promise((r) =>
              setTimeout(r, 5000 * (attempt + 1))
            );
          }
        }
      }

      if (lastError) {
        logError("balance_check_failed", {
          account: entry.name,
          chain: entry.chain,
          token: check.token,
          error: lastError.message,
        });

        const alertKey = `balance:${entry.name}:${check.token}:rpc_error`;
        if (shouldAlert(state, alertKey, "critical", cooldowns)) {
          await sendAlert(
            telegram,
            "critical",
            "RPC Unreachable",
            entry.name,
            `All RPCs unreachable for ${entry.chain}`,
            dryRun
          );
          recordAlert(state, alertKey);
        }
        hasCritical = true;
      }
    }
  }

  return { hasCritical };
}
