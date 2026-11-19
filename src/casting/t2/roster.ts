/**
 * Builds the roster index for T2 with the S3 `unknownStartDates` option and
 * refuses to run when the identity module in this build ignores it.
 *
 * Why the check: T2 is the first stage with a meaningful evidence date, so the
 * employment-window gate is live. A staff `started_at` that is an import
 * placeholder would quarantine real edits as `window_gate`. The caller names
 * such dates (`--unknown-start-date`); an identity module that does not know
 * the option would silently drop the instruction, so a probe row proves it
 * took effect before any evidence is produced.
 */
import {
  buildRosterIndex,
  resolveIdentity,
  type RosterEntry,
  type RosterIndex,
  type RosterIndexOptions,
} from '../identity';

type BuildOptions = RosterIndexOptions & { unknownStartDates?: readonly string[] | undefined };
type BuildFn = (entries: readonly RosterEntry[], options?: RosterIndexOptions) => RosterIndex;

export interface T2RosterOptions {
  agencyDomains: readonly string[];
  unknownStartDates: readonly string[];
}

export function buildT2Roster(
  entries: readonly RosterEntry[],
  options: T2RosterOptions,
  build: BuildFn = buildRosterIndex,
): RosterIndex {
  const buildOptions: BuildOptions = {
    agencyEmailDomains: options.agencyDomains,
    unknownStartDates: options.unknownStartDates,
  };
  const index = build(entries, buildOptions);
  const placeholder = options.unknownStartDates[0];
  if (placeholder !== undefined) assertUnknownStartDatesHonoured(build, placeholder);
  return index;
}

/** One synthetic person whose start is the placeholder must pass the gate for a much earlier date. */
function assertUnknownStartDatesHonoured(build: BuildFn, placeholder: string): void {
  const email = 'probe@probe.invalid';
  const probe = build(
    [
      {
        staffId: 'probe',
        fullName: 'Probe Person',
        email,
        startedAt: placeholder,
        isActive: true,
        isPerson: true,
      },
    ],
    { unknownStartDates: [placeholder] } as BuildOptions,
  );
  const r = resolveIdentity(probe, { rawName: '', rawEmail: email, evidenceDate: '1990-01-01' });
  if (r.personKind !== 'staff') {
    throw new Error(
      'casting-t2: --unknown-start-date is not supported by this build of the identity module (S3 option unknownStartDates missing); refusing to run with the window gate on placeholder dates',
    );
  }
}
