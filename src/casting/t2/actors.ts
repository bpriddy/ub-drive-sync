/**
 * Actor classes of `drive_edit_stats.actor_email`.
 *
 * The column holds whatever the forward driver could make of an Activity
 * actor: an email, the raw `people/<id>` resource when the People API could
 * not resolve it, or the synthetic `(unattributed)` for system / anonymous
 * actors. This stage never calls the People API; it only reads the
 * `people_resource_map` cache the forward driver filled.
 */

export type ActorClass =
  'email' | 'people_cached' | 'people_unresolved' | 'unattributed' | 'unrecognised';

export interface ActorResolution {
  class: ActorClass;
  /** Lower-case trimmed email, or null when the actor has none. */
  email: string | null;
}

const UNATTRIBUTED = '(unattributed)';
const PEOPLE_PREFIX = 'people/';
/** Deliberately loose: the S3 resolver, not this stage, decides what an address means. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isPeopleResource = (actor: string): boolean => actor.startsWith(PEOPLE_PREFIX);

/** `cache` holds the lookups of the people resources of the current page. */
export function classifyActor(
  actor: string,
  cache: ReadonlyMap<string, string | null>,
): ActorResolution {
  const a = actor.trim();
  if (a === UNATTRIBUTED) return { class: 'unattributed', email: null };
  if (isPeopleResource(a)) {
    const email = cache.get(a)?.trim().toLowerCase() ?? null;
    return email !== null && EMAIL_SHAPE.test(email)
      ? { class: 'people_cached', email }
      : { class: 'people_unresolved', email: null };
  }
  if (EMAIL_SHAPE.test(a)) return { class: 'email', email: a.toLowerCase() };
  return { class: 'unrecognised', email: null };
}
