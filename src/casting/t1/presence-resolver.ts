/**
 * Resolves the last-modifier email of a file through the S3 identity module
 * (public index only). Modifiers are few (tens per account), so results are
 * cached per email for the life of the run.
 *
 * The employment-window gate is not evaluated: T1 has no trustworthy date for
 * the moment the person touched the file (see emit.ts). The account gate is
 * not evaluated either, because no account-linked staff set exists at this
 * stage; an email that is not in the roster is still decided by the roster's
 * agency-domain rule (unknown employee vs external), never name-matched.
 */
import { type IdentityResolution, type RosterIndex, resolveIdentity } from '../identity';

export function createPresenceResolver(index: RosterIndex): (email: string) => IdentityResolution {
  const cache = new Map<string, IdentityResolution>();
  return (email: string): IdentityResolution => {
    const hit = cache.get(email);
    if (hit !== undefined) return hit;
    // The email goes in rawEmail only. An email repeated as a "name" would be
    // compared with the roster entry's name and read as an email/name conflict.
    const resolved = resolveIdentity(index, { rawName: '', rawEmail: email });
    cache.set(email, resolved);
    return resolved;
  };
}
