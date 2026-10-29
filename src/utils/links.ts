// Links out to the web. Krypto Mirror has no chart page and no explorer of its
// own — Krypto Bot has the charts — so a coin or a wallet opens on its public
// page in the browser. https only (main refuses anything else).

import { publicTokenUrl } from '@shared/webhook';
import { explorerAddress, type ChainKind } from '@shared/evm';

/** A coin's public page: pump.fun for a Solana mint, the chain's explorer for EVM. */
export function openTokenExternally(mint: string, chain?: ChainKind): void {
  const url = publicTokenUrl(chain ?? (mint.startsWith('0x') ? 'robinhood' : 'solana'), mint);
  if (url) void window.krypt.app.openExternal(url);
}

/** A wallet on the chain's explorer, for checking what this app says against the chain. */
export function openWalletExternally(address: string, chain: ChainKind = 'solana'): void {
  void window.krypt.app.openExternal(chain === 'solana' ? `https://solscan.io/account/${address}` : explorerAddress(chain, address));
}
