// Navigation (2026-10-22). Krypto Mirror has six places and two things any
// page can start from anywhere: open a wallet's profile, and follow a wallet.
// Both live here so Home's suggestions, Discover's board and a Following card
// all open the same profile and the same Follow page.
//
// 2026-10-24: following is a PAGE, not a pop-up — a three-step card could
// only offer a fixed amount, and every other control (sizing by their trade,
// exits, filters) sat behind a second editor reached after the follow
// existed. The page is not a place on the bar; it is where Follow and Edit
// go, and Back returns to wherever it was opened from.
//
// 2026-10-25: Check is a place on the bar — paste any wallet (or a pump.fun
// username) and see what copying it would have done. It was a search box in
// a corner of Discover and a button low on the profile.

import { createContext, useContext } from 'react';
import type { CopyConfig } from '@shared/copytrade';

// 2026-10-28: the address book is a page reached from Following (and any
// "Name this wallet"), not a place on the bar.
export type RouteId = 'home' | 'discover' | 'check' | 'following' | 'activity' | 'wallet' | 'ai' | 'settings' | 'follow' | 'book';

/** The places on the bar. `follow` and `book` are reached from them, not listed. */
export const ROUTES: RouteId[] = ['home', 'discover', 'check', 'following', 'activity', 'wallet', 'ai', 'settings'];

export type SettingsTab = 'general' | 'guides' | 'console' | 'about' | 'legal';
export type ActivityTab = 'copies' | 'positions' | 'history';
export type WalletTab = 'solana' | 'pump' | 'robinhood' | 'bnb';

/** A config as the Follow page edits it: saved ones carry their id. */
export type FollowDraft = Omit<CopyConfig, 'id' | 'createdAt'> & { id?: string };

/** What the Follow page opens on: a new follow (maybe with the wallet
 *  chosen), or a config to edit — a saved one, or a draft such as Reverse. */
export interface FollowTarget {
  address?: string;
  config?: FollowDraft;
}

export interface NavState {
  route: RouteId;
  /** The wallet whose profile is open over Discover, or null. */
  profile: string | null;
  settingsTab: SettingsTab;
  /** The guide Settings › Guides was asked to open (shared/guides/videos.ts id), or null. */
  guide: string | null;
  activityTab: ActivityTab;
  walletTab: WalletTab;
  /** The Follow page's subject while it is open. */
  followTarget: FollowTarget | null;
  /** Where the Follow page goes back to. */
  back: { route: RouteId; profile: string | null } | null;
  /** What Check was asked to check: an address, a username or a link. */
  checkInput: string | null;
}

export interface Nav extends NavState {
  go(route: RouteId, opts?: { settingsTab?: SettingsTab; guide?: string; activityTab?: ActivityTab; walletTab?: WalletTab }): void;
  /** Open a wallet's profile (on Discover). */
  openWallet(address: string): void;
  closeProfile(): void;
  /** Open the Follow page, optionally with the wallet already chosen. */
  follow(address?: string): void;
  /** Open the Follow page on a config: a saved follow to change, or a draft. */
  editFollow(config: FollowDraft): void;
  /** Leave the Follow page for wherever it was opened from. */
  goBack(): void;
  /** Open Check on a wallet (address, pump.fun username or profile link). */
  checkWallet(input: string): void;
}

export const NavContext = createContext<Nav | null>(null);

export function useNav(): Nav {
  const n = useContext(NavContext);
  if (!n) throw new Error('useNav outside NavContext');
  return n;
}
