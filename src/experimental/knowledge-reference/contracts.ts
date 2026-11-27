/**
 * EXPERIMENTAL — strict JSON contracts for the two reference calls, plus hand-written validators.
 * The schemas are shaped for strict structured outputs (all properties required, no extras).
 * Validators re-check everything: a provider's schema enforcement is never trusted on its own.
 */
import { LANGUAGES, MODALITIES, OBLIGATION_STATUSES, SEGMENT_KINDS, UNIT_VERDICTS, isLanguage,
  type AnswerWire, type VerifierWireOutput } from './types';
import { EVIDENCE_REF } from './evidence';

const str = { type: 'string' } as const;
const bool = { type: 'boolean' } as const;
const strArr = { type: 'array', items: str } as const;
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });

export const ANSWER_SCHEMA_NAME = 'odinlink_reference_answer_v3';
/** Answer protocol v3: the reply is written once, as ordered segments (no separate draft). */
export const ANSWER_SCHEMA = obj({
  language: { type: 'string', enum: [...LANGUAGES] },
  obligations: { type: 'array', items: obj({ id: str, description: str, status: { type: 'string', enum: ['answered', 'partially_answered', 'not_in_sources'] } }) },
  reply: { type: 'array', items: obj({
    id: str, kind: { type: 'string', enum: [...SEGMENT_KINDS] }, text: str, modality: { type: 'string', enum: [...MODALITIES] }, conditions: strArr,
    evidence: strArr,
    addresses: strArr,
    newParagraph: bool,
  }) },
});

export const VERIFIER_SCHEMA_NAME = 'odinlink_reference_verification_v4';
export const VERIFIER_SCHEMA = obj({
  obligations: { type: 'array', items: obj({
    id: str, description: str,
    kind: { type: 'string', enum: ['information', 'recommendation', 'requirement', 'permission', 'location', 'other'] },
    availableInSources: bool, sourcesConflict: bool,
    conflictingEvidence: strArr,
    status: { type: 'string', enum: [...OBLIGATION_STATUSES] },
    coveredByUnits: strArr, missingInformation: strArr,
  }) },
  units: { type: 'array', items: obj({
    unitKey: str, verdict: { type: 'string', enum: [...UNIT_VERDICTS] },
    modalityCorrect: bool, conditionsPreserved: bool, languageCorrect: bool, unsupportedAdditions: strArr, independentOfConflicts: bool,
  }) },
  reply: obj({ misleadingAsWhole: bool }),
});

// ---------- validators ----------
type Check = (value: unknown) => boolean;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: unknown, keys: readonly string[]) => isObj(v) && Object.keys(v).length === keys.length && keys.every(k => k in v);
const s = (max: number): Check => v => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const sOpt = (max: number): Check => v => typeof v === 'string' && v.length <= max;
const b: Check = v => typeof v === 'boolean';
const arr = (item: Check, max: number): Check => v => Array.isArray(v) && v.length <= max && v.every(item);
const oneOf = (values: readonly string[]): Check => v => typeof v === 'string' && values.includes(v);
const id: Check = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/u.test(v);
const shape = (spec: Record<string, Check>): Check => v => exact(v, Object.keys(spec)) && Object.entries(spec).every(([k, c]) => c((v as any)[k]));

export const LIMITS = Object.freeze({ units: 24, obligations: 12, evidencePerUnit: 8, unitChars: 600, replyChars: 3600, conditions: 6 });
const ref: Check = v => typeof v === 'string' && EVIDENCE_REF.test(v);

const segmentCheck = shape({
  id, kind: oneOf(SEGMENT_KINDS), text: s(LIMITS.unitChars), modality: oneOf(MODALITIES), conditions: arr(s(300), LIMITS.conditions),
  evidence: arr(ref, LIMITS.evidencePerUnit),
  addresses: arr(id, LIMITS.obligations),
  newParagraph: b,
});
const answerCheck: Check = v => shape({
  language: x => isLanguage(x),
  obligations: arr(shape({ id, description: s(300), status: oneOf(['answered', 'partially_answered', 'not_in_sources']) }), LIMITS.obligations),
  reply: arr(segmentCheck, LIMITS.units),
})(v) && (v as any).reply.reduce((n: number, x: any) => n + x.text.length, 0) <= LIMITS.replyChars;
const verifierCheck = shape({
  obligations: arr(shape({
    id, description: s(300), kind: oneOf(['information', 'recommendation', 'requirement', 'permission', 'location', 'other']),
    availableInSources: b, sourcesConflict: b, conflictingEvidence: arr(ref, 6),
    status: oneOf(OBLIGATION_STATUSES), coveredByUnits: arr(id, LIMITS.units), missingInformation: arr(s(300), 8),
  }), LIMITS.obligations),
  units: arr(shape({ unitKey: v => typeof v === 'string' && /^U[1-9]\d{0,2}$/u.test(v), verdict: oneOf(UNIT_VERDICTS), modalityCorrect: b, conditionsPreserved: b, languageCorrect: b,
    unsupportedAdditions: arr(s(300), 8), independentOfConflicts: b }), LIMITS.units),
  reply: shape({ misleadingAsWhole: b }),
});

const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
export function parseAnswer(text: string): AnswerWire | undefined {
  const value = parse(text);
  return answerCheck(value) ? Object.freeze(value as AnswerWire) : undefined;
}
export function parseVerifier(text: string): VerifierWireOutput | undefined {
  const value = parse(text);
  return verifierCheck(value) ? Object.freeze(value as VerifierWireOutput) : undefined;
}
