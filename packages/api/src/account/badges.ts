// Bitmask of per-user "badges" displayed on the profile card. Lives on the
// auth DB users table (column `badges`). Add a new badge by allocating the
// next free bit - no migration required.
//
// Pure module: imported by the api and admin workers via cross-package path
// the same way plan.ts is.

export const BADGE_DEVELOPER = 1 << 0;
export const BADGE_BETA_TESTER = 1 << 1;

export const ALL_BADGE_BITS = BADGE_DEVELOPER | BADGE_BETA_TESTER;

export function hasBadge(bits: number, badge: number): boolean {
  return (bits & badge) !== 0;
}

export function setBadge(bits: number, badge: number, on: boolean): number {
  return on ? bits | badge : bits & ~badge;
}
