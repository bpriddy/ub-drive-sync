/**
 * Counts-only JSON lines of `casting-run`. Records carry stage names, modes, exit codes,
 * durations and counts: never a name, quote, e-mail or file id. In a paid run the same lines are
 * also appended to `<ledger-dir>.run-log.jsonl` (next to the ledger, never inside it: a file in
 * the ledger directory before the header exists would make the pilot refuse the directory).
 */
import fs from 'node:fs';

export type LogRecord = Readonly<Record<string, unknown>>;

/** One emitter: stdout (injected) plus, when a file is named, the audit file. */
export function makeEmitter(
  out: (line: string) => void,
  file: string | null,
): (rec: LogRecord) => void {
  return (rec) => {
    const line = JSON.stringify(rec);
    out(line);
    if (file !== null) fs.appendFileSync(file, line + '\n');
  };
}
