// Jito's "don't front-run me" marker (2026-10-25).
//
// A transaction that names an account whose address starts with
// `jitodontfront` is rejected by Jito's block engine from any bundle in which
// another transaction comes BEFORE it — the shape of a sandwich. The copy
// builders put it on every buy as the destination of a zero-lamport system
// transfer: about forty bytes, one more account, and an instruction that
// cannot fail (nothing moves; the destination never comes to exist).
//
// It is not protection, and the app never says it is: Axiom set it on 98.5 %
// of its 21.5 M sandwiched victim transactions (arXiv:2609.28115). It covers
// the Jito bundle path only. What keeps a copy out of the sandwiched band is
// the slippage default (shared/copytrade.ts, 8 %: Bitquery measured 87
// sandwiches per 10,000 swaps at 10–20 % slippage against 8 at 1–3 %).

import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';

/** A valid 32-byte address that starts with the marker. */
export const JITO_DONT_FRONT = 'jitodontfront111111111111111111111111111111';

/** The marker as an instruction: a transfer of nothing from `owner`. */
export function dontFrontIx(owner: string): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: new PublicKey(owner), toPubkey: new PublicKey(JITO_DONT_FRONT), lamports: 0 });
}
