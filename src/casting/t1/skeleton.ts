/**
 * Project skeleton: one entry per project of an account, built in a streaming
 * pass over the file index and joined to the accounts database.
 *
 * Memory is bounded by the number of projects, not files: per project a month
 * histogram, a few counters and the set of distinct modifiers. The skeleton is
 * a derived view for the emitter and the run report; it is not stored (the
 * evidence rows carry the project reference and the period).
 */
import {
  type Period,
  DateHistogram,
  NO_PERIOD,
  applyWindow,
  campaignDatePeriod,
  folderYearPeriod,
  usableDate,
} from './period';
import type { ProjectContext, ProjectStrength } from './project-context';
import type { IndexFileRow, ProjectCatalog } from './types';
import { type JobCodeHit, JOB_CODE_FORM_RANK } from './job-code';

export interface ProjectSkeleton {
  key: string;
  strength: ProjectStrength;
  /** Base code, or null for campaign / name-keyed projects. */
  jobNumber: string | null;
  campaignId: string | null;
  pieceId: string | null;
  /** The period after the 5-year window; NO_PERIOD when unknown. */
  period: Period;
  /** True when the whole period lies before the window start: no rows are emitted. */
  outOfWindow: boolean;
  fileCount: number;
  datedFileCount: number;
  modifierCount: number;
  /** The index attributed files of this project to more than one campaign, or to a campaign other than the piece's. */
  campaignConflict: boolean;
}

interface ProjectState {
  key: string;
  strength: ProjectStrength;
  jobCode: JobCodeHit | null;
  /** Segments of the first file seen that carry a year, else of the first file seen. */
  segments: readonly string[];
  segmentsHaveYear: boolean;
  campaigns: Map<string, number>;
  hist: DateHistogram;
  fileCount: number;
  modifiers: Set<string>;
}

export interface SkeletonOptions {
  today: Date;
  /** YYYY-MM-DD, or null for no window. */
  windowStart: string | null;
}

export class SkeletonBuilder {
  private readonly projects = new Map<string, ProjectState>();

  constructor(private readonly options: SkeletonOptions) {}

  get size(): number {
    return this.projects.size;
  }

  add(file: IndexFileRow, ctx: ProjectContext): void {
    if (ctx.projectKey === null) return;
    let state = this.projects.get(ctx.projectKey);
    if (state === undefined) {
      state = {
        key: ctx.projectKey,
        strength: ctx.strength,
        jobCode: ctx.jobCode,
        segments: ctx.contextSegments,
        segmentsHaveYear: false,
        campaigns: new Map(),
        hist: new DateHistogram(),
        fileCount: 0,
        modifiers: new Set(),
      };
      this.projects.set(ctx.projectKey, state);
    }
    state.fileCount += 1;

    // The strongest code form seen for this code wins (a strict bracket beats a variant).
    if (
      ctx.jobCode !== null &&
      state.jobCode !== null &&
      JOB_CODE_FORM_RANK[ctx.jobCode.form] < JOB_CODE_FORM_RANK[state.jobCode.form]
    ) {
      state.jobCode = ctx.jobCode;
      state.strength = ctx.strength;
    }

    if (file.campaignId !== null) {
      state.campaigns.set(file.campaignId, (state.campaigns.get(file.campaignId) ?? 0) + 1);
    }
    if (
      !state.segmentsHaveYear &&
      folderYearPeriod(ctx.contextSegments, this.options.today).basis !== 'none'
    ) {
      state.segments = ctx.contextSegments;
      state.segmentsHaveYear = true;
    }

    const d = usableDate(file.modifiedTime, this.options.today);
    if (d !== null) state.hist.add(d);
    if (file.modifiedBy !== null && file.modifiedBy.trim() !== '') {
      state.modifiers.add(file.modifiedBy.trim().toLowerCase());
    }
  }

  /** Resolves every project against the catalog. Deterministic: sorted by key. */
  build(catalog: ProjectCatalog): Map<string, ProjectSkeleton> {
    const pieceByCode = new Map(catalog.pieces.map((p) => [p.jobNumber, p]));
    const campaignById = new Map(catalog.campaigns.map((c) => [c.id, c]));
    const out = new Map<string, ProjectSkeleton>();

    for (const state of [...this.projects.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
      const code = state.jobCode?.code ?? null;
      const piece = code !== null ? pieceByCode.get(code) : undefined;

      // Majority attribution of the index; ties broken by id for determinism.
      const attributed =
        [...state.campaigns.entries()].sort(
          (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
        )[0]?.[0] ?? null;
      const campaignId = piece?.campaignId ?? attributed;
      const campaignConflict =
        state.campaigns.size > 1 ||
        (piece !== undefined && attributed !== null && attributed !== piece.campaignId);

      let period: Period = NO_PERIOD;
      // Campaign-attributed projects span arbitrary subfolders: no folder years for them.
      if (state.strength !== 'campaign')
        period = folderYearPeriod(state.segments, this.options.today);
      if (period.basis === 'none' && campaignId !== null) {
        period = campaignDatePeriod(campaignById.get(campaignId));
      }
      if (period.basis === 'none') period = state.hist.window();

      const windowed = applyWindow(period, this.options.windowStart);
      out.set(state.key, {
        key: state.key,
        strength: state.strength,
        jobNumber: code,
        campaignId,
        pieceId: piece?.id ?? null,
        period: windowed ?? period,
        outOfWindow: windowed === null,
        fileCount: state.fileCount,
        datedFileCount: state.hist.count,
        modifierCount: state.modifiers.size,
        campaignConflict,
      });
    }
    return out;
  }
}
