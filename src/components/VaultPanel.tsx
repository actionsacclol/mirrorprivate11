// The wallet password's controls: the Settings section, the line on the wallet
// card and the locked chip in the top bar. None of these ever handles a password.
// Every button asks main, and main opens its own window to ask the person.

import { useCallback, useEffect, useState } from 'react';
import { Lock, LockOpen, ShieldCheck } from 'lucide-react';
import type { VaultStatus, VaultWalletRow } from '@shared/vault';
import { useNav } from '../state/nav';
import { useToast } from '../state/ToastProvider';
import { shortAddr } from '../utils/format';
import { Card, GhostButton, PrimaryButton, Section, Switch } from './common';

/** The password's state, kept current. Null until the first read. */
export function useVaultStatus(): VaultStatus | null {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const read = useCallback((): void => {
    void window.krypt.vault.status().then(setStatus);
  }, []);
  useEffect(() => {
    read();
    return window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'vaultChanged' || ev.kind === 'walletSwitched') read();
    });
  }, [read]);
  return status;
}

function useVaultActions() {
  const toast = useToast();
  // Backing out of the password window is not a failure worth a red message.
  const say = (r: { ok: boolean; message: string }): void => {
    if (r.ok) toast.success(r.message);
    else if (/^(Cancelled|Still locked)/.test(r.message)) toast.info(r.message);
    else toast.error(r.message);
  };
  return {
    turnOn: (): void => void window.krypt.vault.turnOn().then(say),
    turnOff: (): void => void window.krypt.vault.turnOff().then(say),
    change: (): void => void window.krypt.vault.change().then(say),
    unlock: (): void => void window.krypt.vault.unlock().then(say),
    lock: (): void => void window.krypt.vault.stopAndLock().then(say),
    setAutoTrade: (w: VaultWalletRow, on: boolean): void => void window.krypt.vault.setAutoTrade(w.family, w.id, on).then(say),
  };
}

export function VaultSection() {
  const status = useVaultStatus();
  const act = useVaultActions();
  if (!status) return null;
  return (
    <Section
      title="Wallet password"
      description="Encrypts your keys, so a program that copies the wallet files gets nothing it can use without the password. Sends, withdrawals, exports and raising your caps then ask for it every time."
    >
      <Card className="space-y-4">
        <span data-testid="vault-section" />
        {!status.on && (
          <>
            <p className="text-note leading-relaxed text-krypt-muted">
              Off: your keys are protected by this computer&apos;s login only, so any program you run can read them.
            </p>
            <PrimaryButton onClick={act.turnOn}>
              <span data-testid="vault-turn-on">Set a password</span>
            </PrimaryButton>
          </>
        )}

        {status.on && (
          <>
            <p className="text-note font-semibold text-white" data-testid="vault-state">
              {status.locked ? 'On, and locked: no wallet can sign' : 'On, and unlocked'}
            </p>
            {status.migrating && !status.locked && (
              <p className="text-note leading-relaxed text-amber-200" data-testid="vault-pending">
                A change to your keys has not finished. Your wallets keep working, and it tries again each time you unlock. If it stays here, a wallet may be damaged: the log says which.
              </p>
            )}
            {status.tampered.length > 0 && (
              <p className="text-note leading-relaxed text-red-300" data-testid="vault-tampered">
                The details of {status.tampered.join(', ')} were changed outside Krypto Mirror, so {status.tampered.length === 1 ? 'it' : 'they'} will not sign. An older version of the app does this when it saves a wallet. If you did not run one, something else on this computer may have edited the file. Check the withdrawal address, then turn the password off and on again to clear this.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {status.locked ? (
                <PrimaryButton onClick={act.unlock}>
                  <span data-testid="vault-unlock">Unlock</span>
                </PrimaryButton>
              ) : (
                <>
                  <GhostButton onClick={act.lock}>
                    <span data-testid="vault-lock">Stop trading and lock</span>
                  </GhostButton>
                  <GhostButton onClick={act.change}>
                    <span data-testid="vault-change">Change password</span>
                  </GhostButton>
                  <GhostButton onClick={act.turnOff}>
                    <span data-testid="vault-turn-off">Turn off</span>
                  </GhostButton>
                </>
              )}
            </div>

            {!status.locked && status.wallets.length > 0 && (
              <div className="space-y-3 border-t border-white/8 pt-3">
                <p className="text-label leading-relaxed text-krypt-muted">
                  Wallets that can auto-trade sign on their own while the app is unlocked. The rest are savings wallets: they stay encrypted while the app runs and sign only right after you type your password.
                </p>
                {status.wallets.map((w) => (
                  <Switch
                    key={`${w.family}:${w.id}`}
                    checked={w.scope !== 'cold'}
                    onChange={(on) => act.setAutoTrade(w, on)}
                    label={`${w.label} (${shortAddr(w.address)})`}
                    description={w.scope === 'cold' ? 'Savings wallet' : w.mustStayHot ? `Can auto-trade. ${w.mustStayHot}` : 'Can auto-trade'}
                  />
                ))}
              </div>
            )}
          </>
        )}

        <div className="space-y-1 border-t border-white/8 pt-3 text-label leading-relaxed text-krypt-muted">
          <p>
            <span className="font-semibold text-white/85">It protects against</span> a stolen computer or backup, a program that copies your files and leaves, and someone at your keyboard while the app is locked. A weak password can still be cracked.
          </p>
          <p>
            <span className="font-semibold text-white/85">It cannot help with</span> malware running while you are unlocked, a fake installer, or a key that leaked before you imported it. Keep only trading money here.
          </p>
          <p>
            <span className="font-semibold text-white/85">It costs you this:</span> after a crash or restart nothing signs until you unlock, including exits. If you lose both the password and the recovery key, those funds are gone for good, and Krypt cannot recover them. To get a new recovery key, turn the password off and on again.
          </p>
        </div>
      </Card>
    </Section>
  );
}

/** One line at the foot of the wallet card. */
export function VaultCardLine({ onClose }: { onClose: () => void }) {
  const status = useVaultStatus();
  const act = useVaultActions();
  const nav = useNav();
  if (!status) return null;
  const link = 'transition hover:text-white';
  return (
    <div className="mt-2 flex items-center justify-center gap-2 text-label text-krypt-muted" data-testid="wallet-card-vault">
      {status.on ? <ShieldCheck className="h-3.5 w-3.5 text-emerald-300/90" /> : <LockOpen className="h-3.5 w-3.5" />}
      <span>Wallet password: {status.on ? (status.locked ? 'locked' : 'on') : 'off'}</span>
      <span aria-hidden>·</span>
      {!status.on && (
        <button onClick={act.turnOn} className={link}>
          Set one
        </button>
      )}
      {status.on && status.locked && (
        <button onClick={act.unlock} className={link}>
          Unlock
        </button>
      )}
      {status.on && !status.locked && (
        <button onClick={act.lock} className={link} data-testid="wallet-card-lock">
          Stop trading and lock
        </button>
      )}
      <span aria-hidden>·</span>
      <button
        onClick={() => {
          onClose();
          nav.go('settings');
        }}
        className={link}
      >
        Settings
      </button>
    </div>
  );
}

/** Beside a row in the wallet list. Not inside the row, which is its own button. */
export function AutoTradeToggle({ row }: { row: VaultWalletRow | undefined }) {
  const act = useVaultActions();
  if (!row || row.scope === 'os') return null;
  const hot = row.scope === 'hot';
  return (
    <button
      onClick={() => act.setAutoTrade(row, !hot)}
      disabled={hot && row.mustStayHot !== null}
      title={hot ? row.mustStayHot ?? 'Can auto-trade. Click to make it a savings wallet.' : 'Savings wallet. Click to let it auto-trade.'}
      className="mr-1 flex-shrink-0 rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-krypt-muted transition hover:text-white disabled:opacity-50"
      data-testid="wallet-autotrade"
    >
      {hot ? 'Auto-trade' : 'Savings'}
    </button>
  );
}

/** In the top bar, only while it matters: nothing can sign until this is pressed. */
export function VaultChip() {
  const status = useVaultStatus();
  const act = useVaultActions();
  if (!status?.on || !status.locked) return null;
  return (
    <button
      onClick={act.unlock}
      title="No wallet can sign until you unlock. Live positions have no exits while locked."
      aria-label="Locked. Unlock your wallets"
      className="flex h-9 flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-amber-400/40 bg-amber-400/10 px-2.5 text-note font-semibold text-amber-200 transition hover:bg-amber-400/20"
      data-testid="vault-chip"
    >
      <Lock className="h-3.5 w-3.5" />
      {/* The word only where the top bar has room for it. */}
      <span className="hidden min-[1400px]:inline">Locked</span>
    </button>
  );
}
