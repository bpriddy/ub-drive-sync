/**
 * Job-code recogniser for T1.
 *
 * `extractJobNumber` (src/drive/job-number.ts) is the authority for the strict
 * bracket form and stays untouched, because other code depends on it. The
 * census of real drives showed it misses two shapes that carry the same code:
 *
 *   - a bracket with a short suffix, `[CODE-01]`;
 *   - the code written without brackets, `CODE12345678 Final Files`.
 *
 * This module adds both, and marks them weaker than the strict form: a strict
 * code is hard piece identity (doctrine in job-number.ts); the two extra shapes
 * are inferences. The unbracketed shape is accepted only when its letter prefix
 * is a prefix the account already uses in strict codes, so an invoice number or
 * a date does not become a job.
 */
import { extractJobNumber } from '../../drive/job-number';

export type JobCodeForm = 'bracket' | 'bracket_variant' | 'unbracketed';

/** Strongest first. */
export const JOB_CODE_FORM_RANK: Readonly<Record<JobCodeForm, number>> = {
  bracket: 0,
  bracket_variant: 1,
  unbracketed: 2,
};

export interface JobCodeHit {
  /** The base code, without suffix or brackets, e.g. `ACME55000216`. */
  code: string;
  /** Letters of the code, e.g. `ACME`. */
  prefix: string;
  form: JobCodeForm;
}

const CODE_BODY = '[A-Z]{2,10}\\d{4,14}';
const BRACKET_VARIANT = new RegExp(`\\[(${CODE_BODY})[-_ .]?([A-Za-z0-9]{1,3})\\]`);
/** Not glued to other letters or digits on either side. */
const UNBRACKETED = new RegExp(`(?<![A-Za-z0-9])(${CODE_BODY})(?![A-Za-z0-9])`);

function prefixOf(code: string): string {
  const m = /^[A-Z]+/.exec(code);
  return m ? m[0] : '';
}

/**
 * The job code in one folder or file name, or null.
 * `knownPrefixes` gates the unbracketed shape; leave it empty to switch that shape off.
 */
export function recogniseJobCode(
  segment: string,
  knownPrefixes: ReadonlySet<string>,
): JobCodeHit | null {
  const strict = extractJobNumber(segment);
  if (strict !== null) return { code: strict, prefix: prefixOf(strict), form: 'bracket' };

  const variant = BRACKET_VARIANT.exec(segment);
  if (variant) {
    const code = variant[1] as string;
    return { code, prefix: prefixOf(code), form: 'bracket_variant' };
  }

  if (knownPrefixes.size > 0) {
    const bare = UNBRACKETED.exec(segment);
    if (bare) {
      const code = bare[1] as string;
      const prefix = prefixOf(code);
      if (knownPrefixes.has(prefix)) return { code, prefix, form: 'unbracketed' };
    }
  }
  return null;
}

/** The letter prefix of a strict bracket code in `segment`, or null. Feeds the prefix census. */
export function strictCodePrefix(segment: string): string | null {
  const code = extractJobNumber(segment);
  return code === null ? null : prefixOf(code);
}

export { prefixOf as jobCodePrefix };
