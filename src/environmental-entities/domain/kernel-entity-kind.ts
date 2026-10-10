/**
 * Name prefix of the kernel-session epoch marker (`kernel-session/domain/kernel-epoch.ts` on the
 * kernel-session-restore branch). It is a far-away TO_BE_IGNORED entity that detects a kernel reset;
 * it is never an obstacle, so the admin obstacle table hides it and refuses to retire it.
 */
export const EPOCH_ENTITY_PREFIX = 'WES-KERNEL-EPOCH-';

export function isEpochMarker(name: string): boolean {
  return name.startsWith(EPOCH_ENTITY_PREFIX);
}
