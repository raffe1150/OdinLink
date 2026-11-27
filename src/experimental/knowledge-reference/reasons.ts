/**
 * EXPERIMENTAL — Knowledge Answer reference path (Phase 1). Not imported by server.ts,
 * channels, webhooks or the durable worker. See README.md in this folder.
 *
 * Every non-publication and every rejected unit carries exactly one of these codes.
 * Codes are fixed labels; they never contain customer text, source text or model text.
 */
export const REASON_CODES = [
  // Input / corpus
  'INPUT_INVALID',
  'NO_SOURCES',
  'TENANT_SOURCE_MISMATCH',
  'SOURCE_NOT_READY',
  'SOURCE_DUPLICATE_ID',
  // Provider (either call)
  'ANSWER_PROVIDER_ERROR',
  'ANSWER_PROVIDER_TIMEOUT',
  'ANSWER_TRUNCATED',
  'VERIFIER_PROVIDER_ERROR',
  'VERIFIER_PROVIDER_TIMEOUT',
  'VERIFIER_TRUNCATED',
  'REQUEST_CORRELATION_MISMATCH',
  // Call 1 contract
  'ANSWER_MALFORMED',
  'ANSWER_LANGUAGE_MISMATCH',
  'ANSWER_NO_UNITS',
  // Deterministic unit checks
  'UNIT_NO_CITATION',
  'EVIDENCE_REF_UNKNOWN',
  'EVIDENCE_MAP_MISMATCH',
  'CITATION_UNKNOWN_SOURCE',
  'CITATION_REVISION_MISMATCH',
  'CITATION_QUOTE_NOT_FOUND',
  'CITATION_QUOTE_TOO_SHORT',
  'NUMBER_NOT_IN_CITATION',
  'UNIT_LANGUAGE_MISMATCH',
  'UNIT_DUPLICATE_ID',
  'UNIT_NOT_RELEVANT',
  'CONDITION_NOT_IN_TEXT',
  'LIMITATION_INVALID',
  'SEGMENTS_COUPLED',
  // Call 2 contract and binding
  'VERIFIER_MALFORMED',
  'VERIFIER_BINDING_MISMATCH',
  'VERIFIER_NO_OBLIGATIONS',
  'VERIFIER_OBLIGATION_UNIT_UNKNOWN',
  'VERIFIER_OBLIGATION_INCONSISTENT',
  // Verifier unit verdicts
  'VERIFIER_NOT_ENTAILED',
  'VERIFIER_PARTIALLY_ENTAILED',
  'VERIFIER_CONTRADICTED',
  'VERIFIER_MODALITY_WRONG',
  'VERIFIER_CONDITIONS_DROPPED',
  'VERIFIER_UNSUPPORTED_ADDITION',
  'VERIFIER_LANGUAGE_WRONG',
  'VERIFIER_REPLY_MISLEADING',
  // Turn-level coverage decisions
  'LIMITATION_NOT_VERIFIED_ABSENT',
  'AVAILABLE_SOURCE_FACT_OMITTED',
  'OBLIGATION_INCOMPLETE',
  'SOURCE_CONFLICT',
  'SOURCE_CONFLICT_WITHHELD',
  'UNIT_DEPENDS_ON_CONFLICT',
  'VERIFIER_CONFLICT_INCONSISTENT',
  'SECRET_IN_UNIT',
  'SECRET_DISCLOSURE_BLOCKED',
  'NOTHING_PUBLISHABLE',
  // Pre-publication
  'STALE_SOURCE',
  'MANIFEST_INTEGRITY_VIOLATION',
  'REVALIDATION_UNAVAILABLE',
  // Reply assembly (informational): the authored reply was not published verbatim; only approved segments were.
  'REPLY_SEGMENTS_OMITTED',
  // Answer protocol v2 only (separate draft); never emitted by protocol v3. Kept so historical results stay valid codes.
  'DRAFT_NOT_APPROVED',
  'DRAFT_NUMBER_UNSUPPORTED',
  // Informational measurements (never block publication by themselves)
  'OBLIGATION_INTERPRETATION_DIVERGED',
] as const;

export type ReasonCode = typeof REASON_CODES[number];
export type ReasonStage = 'input' | 'answer' | 'deterministic' | 'verification' | 'coverage' | 'publication' | 'draft';

export type Reason = Readonly<{
  code: ReasonCode;
  stage: ReasonStage;
  unitId?: string;
  obligationId?: string;
  sourceId?: string;
  /** Content-free detail for diagnosis, e.g. "citation:1" or "number:25". Never customer, source or model text. */
  detail?: string;
  /** true when the reason stopped the whole turn (fallback); false when it only removed a unit or is informational. */
  fatal: boolean;
}>;

export const reason = (code: ReasonCode, stage: ReasonStage, fatal: boolean,
  ids: Readonly<{ unitId?: string; obligationId?: string; sourceId?: string; detail?: string }> = {}): Reason =>
  Object.freeze({ code, stage, fatal, ...ids });
