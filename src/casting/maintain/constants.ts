/**
 * Named constants of the maintenance tools (S9). None is calibrated.
 */

/** The sliding window length (master spec: the last 5 years). Used by the job's default. */
export const WINDOW_YEARS_DEFAULT = 5;

/**
 * Drift thresholds (S9 task 3).
 *
 * TODO(S8): every value below is a PLACEHOLDER. S8 owns the alert thresholds (S9 brief: "alert
 * thresholds from S8") and must ratify or replace them, and name an owner, before any alert or
 * scheduled check reads them. Until then the drift report PRINTS breaches and exits 0; it never
 * fails a job on its own (`--fail-on-breach` is opt-in and meant for a manual check).
 *
 * Every number is [ASSUME]: no calibration data exists (there is no gold set).
 */
export const DRIFT_THRESHOLDS = {
  /** [ASSUME: 50] fewer T3 rows / served claims than this and a rate is reported but not judged. */
  minSample: 50,
  /** [ASSUME: 0.5] share of SERVED claims backed by two or more tiers. */
  tierAgreementRateMin: 0.5,
  /** [ASSUME: 0.05] p90 minus p10 of served confidence; below it the scores no longer rank (the fusion-v1 failure). */
  confidenceSpreadMin: 0.05,
  /** [ASSUME: 0.1] largest absolute move of any rate against the previous report (`--compare`). */
  rateShiftMax: 0.1,
  /** [ASSUME: 0.2] largest relative fall of the served count against the previous report. */
  servedDropMax: 0.2,
} as const;

/** Exit code of the drift report with `--fail-on-breach` and at least one breach. */
export const DRIFT_EXIT_BREACH = 6;
