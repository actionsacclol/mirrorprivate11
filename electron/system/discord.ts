import RPC from 'discord-rpc';
import { logger } from './logger';
import { canonicalPresence } from '@shared/presenceIntegrity';

/**
 * Discord Rich Presence — best-effort, never blocking (guidelines §8).
 * The Discord application is named "krypt.cc", so Discord shows "Playing
 * krypt.cc"; this module sets the two lines (live engine state), the art hover
 * text ("Krypto Mirror") and the two buttons (the tool at krypt.cc/mirror and
 * $KRYPTO). On by default, like the other Krypt tools. Never throw out of here.
 */

// The identity is resolved through the integrity layer, never read from a
// constant in this file: editing a readable client id or button URL in a
// cracked build must change a decoy, not what Discord actually shows. If the
// blob cannot be verified we publish NOTHING rather than someone else's
// branding. See shared/presenceIntegrity.ts.
const identity = () => canonicalPresence();

let client: RPC.Client | null = null;
let connected = false;
let desired = false;
let last: { state: string; details: string } | null = null;
let startedAt = Date.now();
let retry: NodeJS.Timeout | null = null;

/**
 * How often to try again while presence is wanted but not connected.
 *
 * Presence used to be attempted exactly ONCE, at boot. Discord is very often
 * not running at that moment — someone opens the trading app first, or Discord
 * restarts to update — and there was nothing that ever tried again, so the
 * presence simply never appeared for the rest of the session. `disconnected`
 * set a flag and did nothing else, so losing Discord once was permanent too.
 *
 * Thirty seconds is cheap: a failed connect is a named-pipe open that fails
 * immediately, entirely local, and it stops the moment presence is switched
 * off or a connection succeeds.
 */
const RETRY_MS = 30_000;

/**
 * discord-rpc's destroy() is async: with Discord not running its pipe is
 * null, and close() rejects "Cannot read properties of null (reading
 * 'write')". A try/catch around the call never saw it, so every 30 s retry
 * raised an unhandledRejection (user report 09-30; crash file 09-25).
 */
function destroyQuietly(c: RPC.Client | null): void {
  if (!c) return;
  try {
    void Promise.resolve(c.destroy()).catch(() => undefined);
  } catch {
    /* a synchronous throw: already gone */
  }
}

function scheduleRetry(): void {
  if (retry || !desired) return;
  retry = setTimeout(() => {
    retry = null;
    if (!desired || connected) return;
    void startDiscordRpc();
  }, RETRY_MS);
  retry.unref?.();
}

export async function startDiscordRpc(): Promise<void> {
  desired = true;
  if (connected) return;
  const id = identity();
  if (!id) {
    logger.warn('discord presence: identity blob failed its checksum — publishing nothing');
    return;
  }
  // A previous attempt may have left a client behind; never stack them.
  destroyQuietly(client);
  client = null;
  try {
    const c = new RPC.Client({ transport: 'ipc' });
    client = c;
    c.on('ready', () => {
      connected = true;
      startedAt = Date.now();
      logger.info('discord presence: connected');
      pushActivity();
    });
    // Discord closed, restarted, or the pipe dropped. Presence is still
    // WANTED, so go back to trying — this is the whole difference between
    // "on" and "on for as long as Discord happened to be up at boot".
    c.on('disconnected', () => {
      connected = false;
      logger.info('discord presence: disconnected — retrying');
      scheduleRetry();
    });
    await c.login({ clientId: id.clientId });
  } catch (err) {
    // Discord is simply not running yet. Not an error, and not final. Logged
    // rather than written to the console: a console line in a packaged build
    // reaches nobody, and "is presence actually on" has to be answerable after
    // the fact from the app log.
    logger.info(`discord presence: not connected (${(err as Error)?.message ?? 'no reason given'}) — retrying in 30s`);
    connected = false;
    destroyQuietly(client);
    client = null;
    scheduleRetry();
  }
}

export function stopDiscordRpc(): void {
  desired = false;
  if (retry) {
    clearTimeout(retry);
    retry = null;
  }
  destroyQuietly(client);
  client = null;
  connected = false;
  last = null;
}

/**
 * The two presence lines from copy state. Exported so the text is unit-tested
 * without a Discord connection. `details` is line one, `state` line two.
 */
export function presenceLines(input: { follows: number; open: number; liveOpen: number }): { details: string; state: string } {
  if (input.follows <= 0) return { details: 'Copy trading on Solana', state: 'Idle' };
  const follows = input.follows === 1 ? '1 wallet' : `${input.follows} wallets`;
  const open = input.open === 1 ? '1 open' : `${input.open} open`;
  const live = input.liveOpen > 0 ? ' · LIVE' : '';
  return { details: 'Copy trading on Solana', state: `Following ${follows} · ${open}${live}` };
}

export function setActivity(details: string, state: string): void {
  // Status fires about once a second; Discord rate-limits setActivity. Only
  // push when the text actually changed.
  if (last && last.details === details && last.state === state) return;
  last = { details, state };
  pushActivity();
}

function pushActivity(): void {
  if (!connected || !client || !desired) return;
  const id = identity();
  if (!id) return;
  const payload = last ?? { details: 'Idle', state: 'Scanner off' };
  client
    .setActivity({
      details: payload.details,
      state: payload.state,
      largeImageKey: id.largeImageKey,
      largeImageText: id.largeImageText,
      startTimestamp: startedAt,
      instance: false,
      buttons: id.buttons,
    })
    .catch(() => {
      /* best-effort */
    });
}
