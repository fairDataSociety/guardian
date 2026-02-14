import { ethers } from "ethers";

export interface ChainConfig {
  id: number;
  rpc_env: string;
  rpc_default: string;
}

export interface TokenConfig {
  chain: string;
  address: string;
  decimals: number;
}

export function getRpcUrl(chain: ChainConfig): string {
  return process.env[chain.rpc_env] || chain.rpc_default;
}

export const NATIVE_TOKEN_NAMES: Record<number, string> = {
  1: "ETH",
  100: "xDAI",
};

export function nativeTokenName(chainId: number): string {
  return NATIVE_TOKEN_NAMES[chainId] || "ETH";
}

export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
] as const;

const providerCache = new Map<string, ethers.JsonRpcProvider>();

export function getProvider(chain: ChainConfig): ethers.JsonRpcProvider {
  const url = getRpcUrl(chain);
  let provider = providerCache.get(url);
  if (!provider) {
    provider = new ethers.JsonRpcProvider(url, chain.id, {
      staticNetwork: true,
    });
    providerCache.set(url, provider);
  }
  return provider;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number = 5000
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("RPC timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
