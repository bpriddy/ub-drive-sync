/**
 * The run ledger: one JSON line per processed cell (a cell = one document at
 * one prompt / model / thinking configuration). It is what makes a run
 * resumable and what makes the $0 resolve phase possible: validated, grounded
 * mentions are saved next to the usage that paid for them, so a roster change
 * or a resolver fix re-resolves from the ledger without another model call.
 *
 * The ledger holds names and short quotes from client documents. It lives in a
 * directory the operator names, outside any git work tree: `JsonlLedger`
 * refuses a directory inside the repo checkout.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GroundedMention } from './ground';
import type { SanitizeStats } from './schema';
import type { GroundingStats } from './ground';
import type { DocClass, T3Candidate } from './types';

export interface CellUsage {
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly thoughtsTokens: number;
  readonly costUsd: number;
}

export interface CellRecord {
  readonly v: 1;
  readonly cellKey: string;
  /** Configuration the cell ran under (see extractorVersionOf). */
  readonly extractorVersion: string;
  readonly at: string;
  readonly status: 'ok' | 'failed' | 'skipped';
  /** Why failed or skipped. */
  readonly reason: string | null;
  readonly candidate: Pick<T3Candidate, 'fileId' | 'accountId' | 'createdTime' | 'projectRef'>;
  readonly docClass: DocClass;
  readonly contentHash: string | null;
  readonly docType: string | null;
  readonly truncated: boolean;
  readonly sentChars: number | null;
  readonly attempts: number;
  readonly usage: CellUsage | null;
  readonly mentions: readonly GroundedMention[];
  readonly sanitizeStats: SanitizeStats | null;
  readonly groundingStats: GroundingStats | null;
}

export interface Ledger {
  load(): readonly CellRecord[];
  append(rec: CellRecord): void;
}

/** What a cell's identity depends on: change any part and it is a new cell. */
export interface CellConfigSignature {
  readonly promptVersion: string;
  readonly model: string;
  readonly thinkingLevel: string;
  readonly capChars: number;
}

export function cellKeyOf(
  c: Pick<T3Candidate, 'fileId' | 'md5Checksum' | 'modifiedTime'>,
  sig: CellConfigSignature,
): string {
  const versionToken = c.md5Checksum ?? c.modifiedTime ?? '';
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        c.fileId,
        versionToken,
        sig.promptVersion,
        sig.model,
        sig.thinkingLevel,
        sig.capChars,
      ]),
    )
    .digest('hex');
}

/** `extractor_version` written on every row: the purge key of a bad configuration. */
export function extractorVersionOf(sig: CellConfigSignature): string {
  return `t3-${sig.promptVersion}:${sig.model}:${sig.thinkingLevel.toLowerCase()}`;
}

export class MemoryLedger implements Ledger {
  readonly records: CellRecord[] = [];
  load(): readonly CellRecord[] {
    return this.records;
  }
  append(rec: CellRecord): void {
    this.records.push(rec);
  }
}

export function assertOutsideRepo(dir: string, repoRoot: string): string {
  if (!path.isAbsolute(dir)) throw new Error('ledger directory must be an absolute path');
  const resolved = path.resolve(dir);
  const root = path.resolve(repoRoot);
  const rel = path.relative(root, resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('ledger directory must be outside the repository checkout');
  }
  return resolved;
}

export class JsonlLedger implements Ledger {
  private readonly file: string;

  constructor(dir: string, repoRoot: string = process.cwd()) {
    const resolved = assertOutsideRepo(dir, repoRoot);
    fs.mkdirSync(resolved, { recursive: true });
    this.file = path.join(resolved, 'cells.jsonl');
  }

  load(): readonly CellRecord[] {
    if (!fs.existsSync(this.file)) return [];
    const out: CellRecord[] = [];
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const rec = JSON.parse(line) as CellRecord;
        if (rec.v === 1) out.push(rec);
      } catch {
        // A torn last line from a killed run is dropped; its cell simply runs again.
      }
    }
    return out;
  }

  append(rec: CellRecord): void {
    fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
  }
}
