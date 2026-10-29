// Wallet (2026-10-22) — the money a live copy spends, and the pump.fun
// accounts those wallets post and earn with.
//
// Solana first: Solana and pump.fun are the tabs until Robinhood Chain or BNB
// is switched on under Settings. Each chain tab is the wallet page Krypto Bot
// already had — create or import, Paper/Live, the per-trade max, send, back
// up. pump.fun is Wallet › pump.fun (PumpTab.tsx).

import { TabbedPage } from '../components/common';
import { useAppState } from '../state/AppStateProvider';
import { useNav, type WalletTab } from '../state/nav';
import { EvmWalletPage, WalletPage } from './Wallet';
import { PumpTab } from './PumpTab';

export function WalletHub() {
  const { settings } = useAppState();
  const evm = (['robinhood', 'bnb'] as const).filter((c) => settings.evm[c].enabled);
  const nav = useNav();
  // In the navigation state, so Home can open Wallet › pump.fun directly.
  const tab = nav.walletTab;
  const label: Record<WalletTab, string> = { solana: 'Solana', pump: 'pump.fun', robinhood: 'Robinhood Chain', bnb: 'BNB Chain' };
  const tabs: WalletTab[] = ['solana', 'pump', ...evm];
  return (
    <TabbedPage
      title="Wallet"
      subtitle="The wallet live copies trade from, and the pump.fun accounts that call out what they buy. Keys are encrypted on this computer and never leave it."
      value={tab}
      onChange={(t) => nav.go('wallet', { walletTab: t })}
      tabs={tabs.map((t) => ({ value: t, label: label[t] }))}
    >
      {tab === 'solana' ? <WalletPage /> : tab === 'pump' ? <PumpTab /> : <EvmWalletPage chain={tab} />}
    </TabbedPage>
  );
}
