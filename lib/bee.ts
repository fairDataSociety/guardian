import { logInfo, logWarn, logError } from "./logger";

export interface StampInfo {
  batchID: string;
  depth: number;
  bucketDepth: number;
  immutableFlag: boolean;
  batchTTL: number;
  utilization: number;
  usable: boolean;
  exists: boolean;
  amount: string;
}

const GNOSIS_BLOCK_TIME = 5; // seconds

export function ttlDays(batchTTL: number): number {
  return (batchTTL * GNOSIS_BLOCK_TIME) / 86400;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries: number = 3,
  backoffMs: number = 5000
): Promise<Response> {
  let lastError: Error | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(10000),
      });
      return resp;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (i < retries - 1) {
        logWarn("bee_retry", { url, attempt: i + 1, error: lastError.message });
        await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
      }
    }
  }
  throw lastError;
}

export async function checkBeeHealth(beeUrl: string): Promise<boolean> {
  try {
    const resp = await fetchWithRetry(`${beeUrl}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

export async function fetchStamp(
  beeUrl: string,
  batchId: string
): Promise<StampInfo> {
  const resp = await fetchWithRetry(`${beeUrl}/stamps/${batchId}`);

  if (!resp.ok) {
    if (resp.status === 404) {
      throw new Error(`Stamp not found: ${batchId.slice(0, 8)}...`);
    }
    throw new Error(`Bee API error: ${resp.status} ${resp.statusText}`);
  }

  return (await resp.json()) as StampInfo;
}

export interface ChainState {
  chainTip: number;
  block: number;
  totalAmount: string;
  currentPrice: string;
}

export async function fetchChainState(beeUrl: string): Promise<ChainState> {
  const resp = await fetchWithRetry(`${beeUrl}/chainstate`);
  if (!resp.ok) {
    throw new Error(`Chainstate API error: ${resp.status} ${resp.statusText}`);
  }
  return (await resp.json()) as ChainState;
}

/**
 * Calculate per-chunk amount needed for a given number of extra days.
 * amount = extraBlocks * currentPrice
 * extraBlocks = extraDays * 86400 / GNOSIS_BLOCK_TIME
 */
export function calcTopupAmount(extraDays: number, currentPrice: bigint): bigint {
  const extraBlocks = BigInt(Math.ceil((extraDays * 86400) / GNOSIS_BLOCK_TIME));
  return extraBlocks * currentPrice;
}

export async function topupStamp(
  beeUrl: string,
  batchId: string,
  amount: bigint
): Promise<string> {
  const url = `${beeUrl}/stamps/topup/${batchId}/${amount.toString()}`;
  const resp = await fetch(url, {
    method: "PATCH",
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Topup failed: ${resp.status} ${resp.statusText} ${body}`);
  }

  const data = (await resp.json()) as { batchID: string };
  return data.batchID;
}
