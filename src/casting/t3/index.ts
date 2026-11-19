/**
 * T3 stage: Drive document content mentions (S5). Public surface.
 *
 * Deliberately does NOT re-export real-llm.ts or real-reader.ts: the real
 * wiring is imported by name from its own file, only by the entry point that
 * runs a pilot, so importing this index can never reach a model client.
 */
export { runT3 } from './run';
export type { QualityCounters, T3Deps, T3Options, T3Plan, T3Report } from './run';
export { parseT3Args } from './args';
export type { T3Args } from './args';
export { formatProposal } from './proposal';
export { selectCandidates, triage, TRIAGE_VARIANTS } from './triage';
export type { Selection, SelectionPolicy, TriageVariant } from './triage';
export { estimate, estimateAll, ASSUMPTION_PRESETS } from './estimate';
export { JsonlLedger, MemoryLedger, cellKeyOf, extractorVersionOf } from './ledger';
export type { CellRecord, Ledger } from './ledger';
export { MemorySink } from './sink';
export type { T3Sink } from './sink';
export { mentionsResponseSchema, parseMentionsResponse, DOC_TYPES } from './schema';
export { buildPrompt, promptOverheadChars } from './prompt';
export { T3_CALL_TAG, T3_MAX_PARALLEL, T3_PROMPT_VERSION } from './types';
export type { DocumentReader, ReadOutcome, T3Candidate } from './types';
