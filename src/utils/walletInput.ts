// What a user types to name a wallet (2026-10-25): a Solana address, an EVM
// address, a pump.fun username (`name` or `@name`) or a pump.fun profile
// link. Check and Discover's lookup both resolve it here, so a name works the
// same in both. A username costs one public pump.fun read (cached in main).

import { parsePumpHandle, type PumpUser } from '@shared/pumpLookup';

export interface ResolvedWallet {
  chain: 'solana' | 'evm';
  address: string;
  /** The pump.fun account, when the input was a username or link to one. */
  pump: PumpUser | null;
}

export type WalletInputResult = { ok: true; wallet: ResolvedWallet } | { ok: false; message: string };

export async function resolveWalletInput(raw: string): Promise<WalletInputResult> {
  const a = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return { ok: true, wallet: { chain: 'evm', address: a.toLowerCase(), pump: null } };
  const h = parsePumpHandle(a);
  if (!h) return { ok: false, message: 'Paste a wallet address, or a pump.fun username or profile link' };
  if (h.kind === 'address') return { ok: true, wallet: { chain: 'solana', address: h.value, pump: null } };
  const r = await window.krypt.scout.pumpUser(h.value);
  if (!r.ok || !r.data) return { ok: false, message: r.message || `No pump.fun account called ${h.value}` };
  return { ok: true, wallet: { chain: 'solana', address: r.data.wallet, pump: r.data } };
}
