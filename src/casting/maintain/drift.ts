/**
 * Drift monitor core (S9 task 3): from counts read out of Layer 1 and Layer 2 for ONE account to
 * a report of rates, and a check of those rates against named thresholds.
 *
 * Pure. Counts only: no name, quote, e-mail or file id is in or out of this file. The numbers it
 * computes are proxies (there is no ground truth), the same family as `fuse().metrics`:
 *
 *   unresolvedNameRate  share of T3 (content) rows whose name is not one staff row
 *   tierAgreementRate   share of SERVED claims backed by evidence of 2 or more tiers
 *   withheldShare       share of stored claims that carry a withheld reason
 *   servedCount         claims served
 *   confidence spread   p10 / p50 / p90 and min / max of served confidence
 */
import { DRIFT_THRESHOLDS } from './constants';

export interface DriftCounts {
  readonly t3Rows: {
    readonly staff: number;
    readonly external_unresolved: number;
    readonly quarantined: number;
  };
  readonly experience: {
    readonly total: number;
    readonly served: number;
    readonly withheldByReason: Readonly<Record<string, number>>;
    /** Served claims whose linked evidence spans two or more sources (tiers). */
    readonly servedMultiTier: number;
    /** Null when nothing is served. */
    readonly confidence: {
      readonly min: number;
      readonly p10: number;
      readonly p50: number;
      readonly p90: number;
      readonly max: number;
    } | null;
  };
  /** Served claims whose period ended before the window cutoff; null when no cutoff was given. */
  readonly servedBeforeCutoff: number | null;
}

export interface DriftReport {
  readonly fusionVersion: string;
  readonly windowCutoff: string | null;
  readonly t3Rows: number;
  readonly unresolvedNameRate: number | null;
  readonly storedClaims: number;
  readonly servedCount: number;
  readonly withheldShare: number | null;
  readonly withheldByReason: Readonly<Record<string, number>>;
  readonly tierAgreementRate: number | null;
  readonly confidence: DriftCounts['experience']['confidence'];
  readonly confidenceSpread: number | null;
  readonly servedBeforeCutoff: number | null;
}

const ratio = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 1000 : null;

export function computeDrift(
  counts: DriftCounts,
  meta: { readonly fusionVersion: string; readonly windowCutoff: string | null },
): DriftReport {
  const t3 = counts.t3Rows;
  const t3Total = t3.staff + t3.external_unresolved + t3.quarantined;
  const e = counts.experience;
  const withheld = e.total - e.served;
  return {
    fusionVersion: meta.fusionVersion,
    windowCutoff: meta.windowCutoff,
    t3Rows: t3Total,
    unresolvedNameRate: ratio(t3.external_unresolved + t3.quarantined, t3Total),
    storedClaims: e.total,
    servedCount: e.served,
    withheldShare: ratio(withheld, e.total),
    withheldByReason: e.withheldByReason,
    tierAgreementRate: ratio(e.servedMultiTier, e.served),
    confidence: e.confidence,
    confidenceSpread: e.confidence
      ? Math.round((e.confidence.p90 - e.confidence.p10) * 1000) / 1000
      : null,
    servedBeforeCutoff: counts.servedBeforeCutoff,
  };
}

export interface Breach {
  readonly metric: string;
  readonly value: number;
  readonly limit: number;
  readonly rule: string;
}

export interface DriftVerdict {
  readonly breaches: readonly Breach[];
  /** Rules not judged because the sample was below `minSample`. */
  readonly notJudged: readonly string[];
}

export function evaluateDrift(
  report: DriftReport,
  previous: DriftReport | null,
  t = DRIFT_THRESHOLDS,
): DriftVerdict {
  const breaches: Breach[] = [];
  const notJudged: string[] = [];
  const check = (
    metric: string,
    value: number | null,
    sample: number,
    rule: string,
    limit: number,
    bad: (v: number) => boolean,
  ): void => {
    if (value === null || sample < t.minSample) {
      notJudged.push(metric);
      return;
    }
    if (bad(value)) breaches.push({ metric, value, limit, rule });
  };
  // Levels that depend on the account (client-side names, how much is confirmed) are judged
  // only as a change against a baseline report (`--compare`), never against a fixed limit.
  check(
    'tierAgreementRate',
    report.tierAgreementRate,
    report.servedCount,
    'min',
    t.tierAgreementRateMin,
    (v) => v < t.tierAgreementRateMin,
  );
  check(
    'confidenceSpread',
    report.confidenceSpread,
    report.servedCount,
    'min',
    t.confidenceSpreadMin,
    (v) => v < t.confidenceSpreadMin,
  );

  if (previous !== null) {
    const shift = (
      metric: string,
      now: number | null,
      before: number | null,
      sample: number,
    ): void => {
      if (now === null || before === null || sample < t.minSample) return;
      const d = Math.round(Math.abs(now - before) * 1000) / 1000;
      if (d > t.rateShiftMax)
        breaches.push({
          metric: `${metric}Shift`,
          value: d,
          limit: t.rateShiftMax,
          rule: 'max change vs previous',
        });
    };
    shift(
      'unresolvedNameRate',
      report.unresolvedNameRate,
      previous.unresolvedNameRate,
      report.t3Rows,
    );
    shift(
      'tierAgreementRate',
      report.tierAgreementRate,
      previous.tierAgreementRate,
      report.servedCount,
    );
    shift('withheldShare', report.withheldShare, previous.withheldShare, report.storedClaims);
    if (previous.servedCount >= t.minSample) {
      const fall = (previous.servedCount - report.servedCount) / previous.servedCount;
      if (fall > t.servedDropMax) {
        breaches.push({
          metric: 'servedCountFall',
          value: Math.round(fall * 1000) / 1000,
          limit: t.servedDropMax,
          rule: 'max relative fall vs previous',
        });
      }
    }
  }
  return { breaches, notJudged };
}
