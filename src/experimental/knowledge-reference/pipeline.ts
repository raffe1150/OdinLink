/**
 * EXPERIMENTAL — Knowledge Answer reference path, Phase 1.
 *
 *   pin corpus → Call 1 (grounded reply segments, written once) → deterministic checks
 *   → Call 2 (independent verifier: own obligations, per-unit verdicts bound by hash)
 *   → coverage decision → source revalidation → publication
 *
 * Publication rules (never weaker than source-exhaustive production rules):
 *  - Only units that pass every deterministic (objective) check AND that the independent verifier judges ENTAILED with
 *    correct modality, preserved conditions, correct language and no unsupported additions can be published.
 *    Meaning is judged only by the verifier; deterministic checks cover objective invariants (see checkUnit).
 *  - An obligation whose answer is available in the sources but is not fully covered by approved units stops the
 *    whole turn (AVAILABLE_SOURCE_FACT_OMITTED / OBLIGATION_INCOMPLETE), as GUARD_04 does in production.
 *  - Conflicting sources: the conflicting obligation's claims are withheld (localized limitation). Other information is
 *    published only when its independence is established: the verifier says so, it covers no conflicting obligation, and
 *    none of its citations overlaps the verbatim conflicting excerpts. Unprovable conflicts stop the turn (SOURCE_CONFLICT).
 *  - Protected internal information (secrets.ts) is redacted from both model inputs and blocked deterministically in
 *    every unit, draft and final reply.
 *  - Obligations the sources genuinely do not answer get fixed localized limitation copy; nothing is guessed.
 *  - Verified partial recovery: an obligation whose available answer could not be fully verified is withheld entirely, and
 *    the other, independently complete obligations are published with a notice that does not claim absence
 *    (partial_verified_recovery; counted as INCOMPLETE in evaluation). Without any complete obligation the turn falls back.
 *  - Answer protocol v3 (reply.ts): the reply is authored ONCE as ordered segments (claims with evidence; limitations that say plainly
 *    what is not available). There is no separate draft. The authored reply is published verbatim (complete_draft / partial_draft)
 *    only when every segment passed and was approved and nothing was withheld, conflicting or dropped; otherwise only the approved
 *    segments are published, in authored order and paragraphs, and fixed copy closes any gap. A limitation segment is published only
 *    for an obligation the verifier independently found (partly) absent from the sources.
 *  - Customer-visible fidelity (2026-11-25, Pilot 5 sv-08): the verifier sees only the customer-visible text; the answerer's
 *    `conditions` list is metadata, never published, never sent to the verifier, and every number it names must be in the text.
 *
 * Not imported by server.ts, channels, webhooks or the durable worker. No network code. No timers beyond per-call aborts.
 */
import { pinCorpus, type PinnedCorpus, type RevalidateSources } from './corpus';
import { ANSWER_SCHEMA, ANSWER_SCHEMA_NAME, VERIFIER_SCHEMA, VERIFIER_SCHEMA_NAME, parseAnswer, parseVerifier } from './contracts';
import { FALLBACK, NOT_IN_SOURCES, REMAINING, VERIFICATION_REMAINING } from './localization';
import { ANSWER_INSTRUCTIONS, VERIFIER_INSTRUCTIONS, answerInput, verifierInput } from './prompts';
import { bindVerdicts, buildManifest, manifestIntact } from './manifest';
import { assembleReply, assembleSubset, coupleSegments } from './reply';
import { evidenceMapMatches, resolveEvidence } from './evidence';
import { reason, type Reason, type ReasonCode } from './reasons';
import { disclosesProtected, REDACTION } from './secrets';
import {
  ALL_LANGUAGES, MIN_QUOTE_CHARS, languagePlausible, normalizeText, numbersIn, quoteOccursIn, sha256,
} from './text-checks';
import { costUsd, REFERENCE_MAX_OUTPUT, requestBytes, requestSha256 } from './wire';
import {
  isLanguage, type AnswerOutput, type AnswerUnit, type AnswererObligation, type Language, type ProviderRequest, type ProviderResult, type ReferenceInput,
  type ReferenceProvider, type ReferenceResult, type StageMetrics, type VerifierOutput, type VerifierWireOutput, type AnswerWire,
} from './types';

export type ReferenceOptions = Readonly<{
  provider: ReferenceProvider;
  /** Host check of current source revisions immediately before publication. */
  revalidate: RevalidateSources;
  /** Per-call abort bounds. Measurement settings for evaluation, NOT a production latency requirement. */
  timeouts: Readonly<{ answerMs: number; verifierMs: number }>;
  now?: () => number;
  /** Authorized local evaluations only: attach the structured answer, deterministic rejections and verifier output (secret-redacted). */
  captureEvidence?: boolean;
}>;

export { unitHash, draftHash } from './manifest';

type CallOutcome = { ok: true; result: ProviderResult } | { ok: false; code: ReasonCode };

async function call(role: 'answer' | 'verifier', request: Omit<ProviderRequest, 'signal'>, options: ReferenceOptions,
  metrics: StageMetrics[]): Promise<CallOutcome> {
  const now = options.now ?? Date.now;
  const ms = role === 'answer' ? options.timeouts.answerMs : options.timeouts.verifierMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const started = now();
  const bytes = requestBytes(request);
  const prefix = role === 'answer' ? 'ANSWER' : 'VERIFIER';
  try {
    const result = await Promise.race([
      options.provider({ ...request, signal: controller.signal }),
      new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })),
    ]);
    const usage = result.usage;
    // Software-owned correlation: the result must belong to the exact request this call constructed.
    if (result.requestSha256 !== requestSha256(request)) {
      metrics.push({ role, model: result.model, latencyMs: now() - started, requestBytes: bytes, outcome: 'error', ...(usage ? { usage, costUsd: costUsd(usage) } : {}) });
      return { ok: false, code: 'REQUEST_CORRELATION_MISMATCH' };
    }
    const truncated = result.status !== 'completed';
    metrics.push({ role, model: result.model, latencyMs: now() - started, requestBytes: bytes, outcome: truncated ? 'truncated' : 'ok',
      ...(usage ? { usage, costUsd: costUsd(usage) } : {}) });
    return truncated ? { ok: false, code: `${prefix}_TRUNCATED` as ReasonCode } : { ok: true, result };
  } catch {
    const timedOut = controller.signal.aborted;
    metrics.push({ role, latencyMs: now() - started, requestBytes: bytes, outcome: timedOut ? 'timeout' : 'error' });
    return { ok: false, code: `${prefix}_${timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR'}` as ReasonCode };
  } finally { clearTimeout(timer); }
}

export type UnitCheck = Readonly<{ code: ReasonCode; detail?: string }>;
/**
 * Deterministic checks for one unit: objective invariants only.
 * Secrets, citation presence, source identity and revision, verbatim quotes, script/language, and numbers. A number in the unit must
 * appear in its cited quotes OR be supplied by the customer (question or customer history turns): a customer's hypothetical
 * "20 minutes" is not a source claim. Whether the unit's MEANING is entailed (modality, negation, conditions, qualifiers) is the
 * independent verifier's binding verdict, not a keyword heuristic.
 */
export function checkUnit(unit: AnswerUnit, corpus: PinnedCorpus, language: Language, customerNumbers: ReadonlySet<number> = new Set()): UnitCheck | undefined {
  if (disclosesProtected([unit.text, ...unit.conditions, ...unit.citations.map(c => c.quote)].join(' '), corpus.protectedTokens)) return { code: 'SECRET_IN_UNIT' };
  if (!unit.citations.length) return { code: 'UNIT_NO_CITATION' };
  for (const [i, citation] of unit.citations.entries()) {
    const source = corpus.byId.get(citation.sourceId);
    if (!source) return { code: 'CITATION_UNKNOWN_SOURCE', detail: `citation:${i}` };
    if (citation.revision !== source.revision) return { code: 'CITATION_REVISION_MISMATCH', detail: `citation:${i}` };
    if (citation.quote.replace(/\s+/gu, ' ').trim().length < MIN_QUOTE_CHARS) return { code: 'CITATION_QUOTE_TOO_SHORT', detail: `citation:${i}` };
    if (!quoteOccursIn(citation.quote, source.modelContent)) return { code: 'CITATION_QUOTE_NOT_FOUND', detail: `citation:${i}` };
  }
  if (!languagePlausible(unit.text, language)) return { code: 'UNIT_LANGUAGE_MISMATCH' };
  const evidenceNumbers = numbersIn(unit.citations.map(c => c.quote).join(' \n '), ALL_LANGUAGES, true);
  // Quantities only (digits and cardinal number words). Ordinal WORDS ("first", "primero", "erste", "اول") are positions that double
  // as adverbs ("describe it first" = "beforehand"; genuine Stage B es-conv-t1 lost a correct unit to "primero" = 1). Whether a stated
  // position is entailed is the independent verifier's binding verdict, exactly as for conditions below.
  for (const n of numbersIn([unit.text, ...unit.conditions].join(' '), [language], false, true))
    if (!evidenceNumbers.has(n) && !customerNumbers.has(n)) return { code: 'NUMBER_NOT_IN_CITATION', detail: `number:${n}` };
  // Metadata cannot stand in for customer-visible text: a QUANTITY (digits or cardinal number words; ordinals such as "first" are
  // positions, which the text may express any way) that the unit declares as a condition must be stated in the text.
  const textNumbers = numbersIn(unit.text, [language]);
  for (const n of numbersIn(unit.conditions.join(' '), [language], false, true))
    if (!textNumbers.has(n)) return { code: 'CONDITION_NOT_IN_TEXT', detail: `number:${n}` };
  return undefined;
}

/** Deterministic checks for a limitation segment ("this information is not available"): it carries no evidence, conditions or
 * modality, states no number the customer did not supply, is in the response language, and addresses an obligation the answerer
 * marked as (partly) not in the sources. Whether the information is REALLY absent is the verifier's binding judgment. */
export function checkLimitation(unit: AnswerUnit, language: Language, customerNumbers: ReadonlySet<number>,
  obligations: readonly AnswererObligation[]): UnitCheck | undefined {
  if ((unit.evidence ?? []).length || unit.citations.length || unit.conditions.length || unit.modality !== 'descriptive')
    return { code: 'LIMITATION_INVALID', detail: 'shape' };
  const open = new Set(obligations.filter(o => o.status !== 'answered').map(o => o.id));
  if (!unit.addresses.some(a => open.has(a))) return { code: 'LIMITATION_INVALID', detail: 'obligation' };
  if (!languagePlausible(unit.text, language)) return { code: 'UNIT_LANGUAGE_MISMATCH' };
  for (const n of numbersIn(unit.text, [language])) if (!customerNumbers.has(n)) return { code: 'LIMITATION_INVALID', detail: `number:${n}` };
  return undefined;
}

/** Numbers the customer supplied in the latest message or earlier customer turns (never assistant turns). */
export const customerSuppliedNumbers = (question: string, history: ReferenceInput['history'], language: Language): Set<number> =>
  numbersIn([question, ...history.filter(t => t.role === 'user').map(t => t.content)].join(' '), [language]);

/** Deep copy with every string that discloses protected information replaced (evidence capture). */
function redactDeep<T>(value: T, tokens: readonly string[]): T {
  if (typeof value === 'string') return (disclosesProtected(value, tokens) ? REDACTION : value) as T;
  if (Array.isArray(value)) return value.map(v => redactDeep(v, tokens)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, tokens)])) as T;
  return value;
}

function verifierUnitReason(v: VerifierOutput['units'][number]): ReasonCode | undefined {
  if (v.verdict === 'CONTRADICTED') return 'VERIFIER_CONTRADICTED';
  if (v.verdict === 'NOT_ENTAILED') return 'VERIFIER_NOT_ENTAILED';
  if (v.verdict === 'PARTIALLY_ENTAILED') return 'VERIFIER_PARTIALLY_ENTAILED';
  if (!v.modalityCorrect) return 'VERIFIER_MODALITY_WRONG';
  if (!v.conditionsPreserved) return 'VERIFIER_CONDITIONS_DROPPED';
  if (v.unsupportedAdditions.length) return 'VERIFIER_UNSUPPORTED_ADDITION';
  if (!v.languageCorrect) return 'VERIFIER_LANGUAGE_WRONG';
  return undefined;
}

const sentences = (text: string) => normalizeText(text).split(/(?<=[.!?\u061F])\s+/u).filter(t => t.length >= MIN_QUOTE_CHARS);
/** A citation overlaps a conflicting excerpt when, in the same source, either contains the other or they share a sentence. */
export function citationOverlaps(citation: Readonly<{ sourceId: string; quote: string }>, conflict: Readonly<{ sourceId: string; quote: string }>): boolean {
  if (citation.sourceId !== conflict.sourceId) return false;
  const a = normalizeText(citation.quote), b = normalizeText(conflict.quote);
  if (a.includes(b) || b.includes(a)) return true;
  const sa = sentences(a), sb = sentences(b);
  return sa.some(x => sb.some(y => x.includes(y) || y.includes(x)));
}

export async function runReferenceAnswer(input: ReferenceInput, options: ReferenceOptions): Promise<ReferenceResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const reasons: Reason[] = [];
  const metrics: StageMetrics[] = [];
  const language: Language = isLanguage(input?.language) ? input.language : 'en';
  const unitTrace = new Map<string, { id: string; modality: AnswerUnit['modality']; deterministic: 'pass' | 'fail'; verifier?: string; approved: boolean }>();
  let answererObligations = 0;
  let verifierTrace: ReferenceResult['trace']['verifierObligations'] = [];

  let protectedTokens: readonly string[] = [];
  const evidence: { answer?: AnswerOutput; answerWire?: AnswerWire; evidenceMapId?: string; deterministic: { unitId: string; code: string; detail?: string }[]; verifier?: VerifierWireOutput;
    manifest?: NonNullable<ReferenceResult['evidence']>['manifest'] } = { deterministic: [] };
  // Frozen manifest snapshots' citations, filled once the manifest exists; the result reports the sources its published text cites.
  const snapshotCitations = new Map<string, readonly Readonly<{ sourceId: string; revision: string }>[]>();
  const finish = (publication: ReferenceResult['publication'], text: string, published: readonly string[] = [], limitations: readonly string[] = []): ReferenceResult => {
    if (publication !== 'fallback' && disclosesProtected(text, protectedTokens)) {
      reasons.push(reason('SECRET_DISCLOSURE_BLOCKED', 'publication', true));
      publication = 'fallback'; text = FALLBACK[language]; published = []; limitations = [];
    }
    const costs = metrics.map(m => m.costUsd);
    return Object.freeze({
      publication, text, publishedUnitIds: Object.freeze([...published]), limitationObligationIds: Object.freeze([...limitations]),
      citedSources: Object.freeze([...new Map(published.flatMap(id => snapshotCitations.get(id) ?? [])
        .map(c => [c.sourceId, Object.freeze({ id: c.sourceId, revision: c.revision })])).values()]),
      reasons: Object.freeze([...reasons]),
      metrics: Object.freeze({ totalMs: now() - started, stages: Object.freeze([...metrics]),
        ...(costs.length && costs.every(c => c !== undefined) ? { costUsd: costs.reduce((a, c) => a + c!, 0) } : {}) }),
      trace: Object.freeze({ answererObligations, verifierObligations: verifierTrace, units: Object.freeze([...unitTrace.values()]) }),
      ...(options.captureEvidence ? { evidence: Object.freeze(redactDeep(evidence, protectedTokens)) } : {}),
    });
  };
  const fail = (code: ReasonCode, stage: Reason['stage'], ids: Parameters<typeof reason>[3] = {}) => {
    reasons.push(reason(code, stage, true, ids));
    return finish('fallback', FALLBACK[language]);
  };

  // ---- input and corpus ----
  const question = typeof input?.question === 'string' ? input.question.trim() : '';
  if (!isLanguage(input?.language) || !question || question.length > 2000 || !Array.isArray(input.history) ||
      !input.history.every(t => (t?.role === 'user' || t?.role === 'assistant') && typeof t.content === 'string')) return fail('INPUT_INVALID', 'input');
  // Optional understanding-stage interpretation: bounded, trimmed; never evidence and never a source of customer-supplied numbers.
  const interpretation = typeof input.interpretation === 'string' && input.interpretation.trim() && input.interpretation.length <= 600
    && input.interpretation.trim() !== question ? input.interpretation.trim() : undefined;
  const pinned = pinCorpus(input.businessId, input.sources ?? [], input.protectedTerms ?? []);
  if (!pinned.corpus) { reasons.push(...pinned.reasons); return finish('fallback', FALLBACK[language]); }
  const corpus = pinned.corpus;
  protectedTokens = corpus.protectedTokens;

  // ---- Call 1: grounded answer ----
  const answerCall = await call('answer', { role: 'answer', instructions: ANSWER_INSTRUCTIONS,
    input: answerInput({ question, language, history: input.history, corpus, ...(interpretation ? { interpretation } : {}) }), schemaName: ANSWER_SCHEMA_NAME, schema: ANSWER_SCHEMA,
    maxOutputTokens: REFERENCE_MAX_OUTPUT.answer }, options, metrics);
  // Explicit narrowing: the repository tsconfig is not strict, where `!x.ok` does not narrow the union.
  if (answerCall.ok === false) return fail((answerCall as Extract<CallOutcome, { ok: false }>).code, 'answer');
  const answerWire = parseAnswer(answerCall.result.text);
  if (!answerWire) { (metrics.at(-1) as any).outcome = 'malformed'; return fail('ANSWER_MALFORMED', 'answer'); }
  answererObligations = answerWire.obligations.length;
  evidence.answerWire = answerWire;
  evidence.evidenceMapId = corpus.evidence.id;
  if (answerWire.language !== language) return fail('ANSWER_LANGUAGE_MISMATCH', 'answer');
  const ids = answerWire.reply.map(u => u.id);
  if (new Set(ids).size !== ids.length) return fail('UNIT_DUPLICATE_ID', 'deterministic');
  // Citation protocol v2: software resolves evidence references against the map built from exactly this pinned corpus.
  if (!evidenceMapMatches(corpus.evidence, corpus.businessId, corpus.sources)) return fail('EVIDENCE_MAP_MISMATCH', 'deterministic');
  const unresolved = new Map<string, { code: ReasonCode; detail: string }>();
  // Answer protocol v3: the reply's segments ARE the units; the authored reply is assembled from them by software.
  // Coupled claims (reply.ts): adjacent same-paragraph claims citing a common passage are verified as ONE segment.
  const coupled = coupleSegments(answerWire.reply);
  for (const id of coupled.merged) reasons.push(reason('SEGMENTS_COUPLED', 'deterministic', false, { unitId: id }));
  const units: AnswerUnit[] = coupled.reply.map(({ evidence: refs, ...u }) => {
    const r = resolveEvidence(corpus.evidence, refs);
    if (r.failure) unresolved.set(u.id, r.failure);
    return Object.freeze({ ...u, evidence: Object.freeze([...new Set(refs)]), citations: Object.freeze(r.citations ?? []) });
  });
  const answer: AnswerOutput = Object.freeze({ language: answerWire.language, obligations: answerWire.obligations,
    units: Object.freeze(units), draft: assembleReply(units) });
  evidence.answer = answer;

  // ---- deterministic checks ----
  const passing: AnswerUnit[] = [];
  let deterministicFailures = 0;
  const customerNumbers = customerSuppliedNumbers(question, input.history, language);
  for (const unit of answer.units) {
    // Secret disclosure is checked first, whatever the unit cites; then evidence resolution; then the objective checks.
    const leaks = disclosesProtected([unit.text, ...unit.conditions].join(' '), corpus.protectedTokens);
    const check = leaks ? { code: 'SECRET_IN_UNIT' as ReasonCode } : unresolved.get(unit.id) ?? (unit.kind === 'limitation'
      ? checkLimitation(unit, language, customerNumbers, answer.obligations) : checkUnit(unit, corpus, language, customerNumbers));
    unitTrace.set(unit.id, { id: unit.id, modality: unit.modality, deterministic: check ? 'fail' : 'pass', approved: false });
    if (check) {
      deterministicFailures++;
      reasons.push(reason(check.code, 'deterministic', false, { unitId: unit.id, ...(check.detail ? { detail: check.detail } : {}) }));
      evidence.deterministic.push({ unitId: unit.id, code: check.code, ...(check.detail ? { detail: check.detail } : {}) });
    } else passing.push(unit);
  }

  // ---- Call 2: independent verification (always runs, also with zero units, to confirm absence independently) ----
  // Binding protocol v2: software-owned manifest (manifest.ts). The model returns unit keys only, never hashes.
  const manifest = buildManifest(passing, assembleReply(passing), corpus.evidence.id);
  for (const e of manifest.entries) snapshotCitations.set(e.unitId, e.unit.citations.map(c => ({ sourceId: c.sourceId, revision: c.revision })));
  evidence.manifest = { id: manifest.id, entries: manifest.entries.map(e => ({ key: e.key, unitId: e.unitId, hash: e.hash })), draftHash: manifest.draftHash };
  const verifierCall = await call('verifier', { role: 'verifier', instructions: VERIFIER_INSTRUCTIONS,
    input: verifierInput({ question, language, history: input.history, corpus, manifest, ...(interpretation ? { interpretation } : {}) }),
    schemaName: VERIFIER_SCHEMA_NAME, schema: VERIFIER_SCHEMA, maxOutputTokens: REFERENCE_MAX_OUTPUT.verifier }, options, metrics);
  if (verifierCall.ok === false) return fail((verifierCall as Extract<CallOutcome, { ok: false }>).code, 'verification');
  const wire = parseVerifier(verifierCall.result.text);
  if (!wire) { (metrics.at(-1) as any).outcome = 'malformed'; return fail('VERIFIER_MALFORMED', 'verification'); }
  evidence.verifier = wire;
  // Conflicting evidence is cited by reference too; an unknown reference resolves to nothing, so the conflict cannot be proven.
  const resolveConflict = (refs: readonly string[]) => {
    const passages = refs.map(r => corpus.evidence.byRef.get(r));
    return passages.every(Boolean) ? passages.map(p => ({ sourceId: p!.sourceId, quote: p!.text })) : [];
  };
  const bound = bindVerdicts(manifest, wire, resolveConflict);
  if (!bound.output) return fail(bound.failure!.code, 'verification', { detail: bound.failure!.detail, ...(bound.failure!.obligationId ? { obligationId: bound.failure!.obligationId } : {}) });
  const verdicts = bound.output;
  if (!verdicts.obligations.length) return fail('VERIFIER_NO_OBLIGATIONS', 'verification');
  if (verdicts.reply.misleadingAsWhole) return fail('VERIFIER_REPLY_MISLEADING', 'verification');
  const sent = manifest.entries;

  const approved = new Set<string>();
  for (const v of verdicts.units) {
    const code = verifierUnitReason(v);
    const trace = unitTrace.get(v.unitId)!;
    trace.verifier = code ?? 'APPROVED';
    if (code) reasons.push(reason(code, 'verification', false, { unitId: v.unitId }));
    else { approved.add(v.unitId); trace.approved = true; }
  }
  if (answererObligations !== verdicts.obligations.length) reasons.push(reason('OBLIGATION_INTERPRETATION_DIVERGED', 'coverage', false));

  // ---- conflicts: withhold conflicting claims; keep only information whose independence is established ----
  const verdictById = new Map(verdicts.units.map(v => [v.unitId, v]));
  const conflicted = new Set<string>();
  const conflictQuotes: { sourceId: string; quote: string }[] = [];
  for (const o of verdicts.obligations.filter(x => x.sourcesConflict)) {
    const proven = o.conflictingQuotes.length >= 2 && o.conflictingQuotes.every(q => {
      const source = corpus.byId.get(q.sourceId);
      return !!source && quoteOccursIn(q.quote, source.modelContent);
    });
    if (!proven) return fail('SOURCE_CONFLICT', 'coverage', { obligationId: o.id }); // independence cannot be established
    conflicted.add(o.id); conflictQuotes.push(...o.conflictingQuotes);
  }
  if (!conflicted.size && verdicts.units.some(v => !v.independentOfConflicts)) return fail('VERIFIER_CONFLICT_INCONSISTENT', 'verification');
  // Publication uses the frozen manifest snapshots; first confirm the answer held in memory still matches what was verified.
  if (!manifestIntact(manifest, passing, assembleReply(passing), corpus.evidence.id)) return fail('MANIFEST_INTEGRITY_VIOLATION', 'publication');
  const unitsById = new Map(manifest.entries.map(e => [e.unitId, e.unit]));
  const dependent = new Set<string>();
  if (conflicted.size) {
    for (const o of verdicts.obligations) if (conflicted.has(o.id)) o.coveredByUnits.forEach(u => dependent.add(u));
    for (const id of approved) if (!verdictById.get(id)!.independentOfConflicts ||
        unitsById.get(id)!.citations.some(c => conflictQuotes.some(q => citationOverlaps(c, q)))) dependent.add(id);
    for (const id of dependent) if (approved.has(id)) {
      approved.delete(id); unitTrace.get(id)!.approved = false;
      reasons.push(reason('UNIT_DEPENDS_ON_CONFLICT', 'coverage', false, { unitId: id }));
    }
  }

  // ---- coverage decision per independently derived obligation ----
  const limitations: string[] = [];
  const publishOrder: string[] = [];
  verifierTrace = Object.freeze(verdicts.obligations.map(o => Object.freeze({ id: o.id, kind: o.kind, availableInSources: o.availableInSources,
    status: o.status, approvedUnits: o.coveredByUnits.filter(u => approved.has(u)).length })));
  // Every obligation is evaluated and every failure reported (verifier obligation ids), not just the first one.
  const coverageFailures: Reason[] = [];
  const completeIds: string[] = [];
  const failObligation = (code: ReasonCode, id: string) => coverageFailures.push(reason(code, 'coverage', true, { obligationId: id }));
  const kindOf = (id: string) => unitsById.get(id)?.kind ?? 'claim';
  const absent = new Set<string>(); // obligations the verifier found (partly) absent from the sources (not conflicts)
  for (const o of verdicts.obligations) {
    const covering = o.coveredByUnits;
    if (conflicted.has(o.id) || covering.some(u => dependent.has(u))) {
      reasons.push(reason('SOURCE_CONFLICT_WITHHELD', 'coverage', false, { obligationId: o.id }));
      limitations.push(o.id);
      continue;
    }
    // "Not in the sources" and "relevant source facts are missing" cannot both be true: never guess which one is.
    if (!o.availableInSources && o.missingInformation.length) { failObligation('VERIFIER_OBLIGATION_INCONSISTENT', o.id); continue; }
    // Absent from the sources (independently judged): publish only what is approved for it (limitation segments that say so, and
    // any approved claim that bears on it). A rejected segment is simply not published; fixed copy closes the gap if needed.
    if (!o.availableInSources) {
      reasons.push(reason('OBLIGATION_INCOMPLETE', 'coverage', false, { obligationId: o.id }));
      limitations.push(o.id); absent.add(o.id);
      publishOrder.push(...covering.filter(u => approved.has(u)));
      continue;
    }
    // Available in the sources: only claims can answer it. A limitation covering it is not a verified absence.
    for (const u of covering) if (kindOf(u) === 'limitation' && approved.has(u)) {
      approved.delete(u); unitTrace.get(u)!.approved = false;
      reasons.push(reason('LIMITATION_NOT_VERIFIED_ABSENT', 'coverage', false, { unitId: u, obligationId: o.id }));
    }
    const claims = covering.filter(u => kindOf(u) === 'claim');
    const allApproved = claims.length > 0 && claims.every(u => approved.has(u));
    if (o.status === 'complete' && allApproved) { publishOrder.push(...claims); completeIds.push(o.id); continue; }
    if (o.missingInformation.length) { failObligation('AVAILABLE_SOURCE_FACT_OMITTED', o.id); continue; }
    if (claims.some(u => !approved.has(u))) { failObligation('OBLIGATION_INCOMPLETE', o.id); continue; }
    if (o.status === 'complete') { failObligation('OBLIGATION_INCOMPLETE', o.id); continue; } // complete but no units
    if (o.status === 'not_addressed') { failObligation('AVAILABLE_SOURCE_FACT_OMITTED', o.id); continue; }
    // Partly absent (available, incomplete, nothing missing that the sources state): publish what is approved, state the limitation.
    reasons.push(reason('OBLIGATION_INCOMPLETE', 'coverage', false, { obligationId: o.id }));
    limitations.push(o.id); absent.add(o.id);
    publishOrder.push(...claims);
  }
  // Verified partial recovery: an obligation whose available answer could not be fully verified is WITHHELD ENTIRELY (none of
  // its units are published, so no condition or exception can be split from its claim), while independently complete
  // obligations are still answered. Requires at least one complete obligation; otherwise the turn falls back as before.
  const withheld = coverageFailures.map(r => r.obligationId!);
  if (coverageFailures.length && !completeIds.length) { reasons.push(...coverageFailures); return finish('fallback', FALLBACK[language]); }
  reasons.push(...coverageFailures.map(r => Object.freeze({ ...r, fatal: false })));
  // A limitation segment is published only if EVERY obligation that lists it is one the verifier found (partly) absent.
  const limitationOk = (id: string) => verdicts.obligations.filter(o => o.coveredByUnits.includes(id)).every(o => absent.has(o.id));
  const published = [...new Set(publishOrder)].filter(id => approved.has(id) && (kindOf(id) === 'claim' || limitationOk(id)));
  for (const id of approved) if (!published.includes(id)) reasons.push(reason('UNIT_NOT_RELEVANT', 'coverage', false, { unitId: id }));

  // ---- revalidate cited sources immediately before publication ----
  const cited = [...new Set(published.flatMap(id => unitsById.get(id)!.citations.map(c => c.sourceId)))];
  if (cited.length) {
    let current: ReadonlyMap<string, string>;
    try { current = await options.revalidate(corpus.businessId, cited); } catch { return fail('REVALIDATION_UNAVAILABLE', 'publication'); }
    for (const id of cited) if (current.get(id) !== corpus.byId.get(id)!.revision) return fail('STALE_SOURCE', 'publication', { sourceId: id });
  }

  // ---- publication ----
  if (!published.length) {
    if (limitations.length === verdicts.obligations.length) return finish('not_in_sources', NOT_IN_SOURCES[language], [], limitations);
    reasons.push(reason('NOTHING_PUBLISHABLE', 'publication', true));
    return finish('fallback', FALLBACK[language]);
  }
  // Assembly (reply.ts): approved segments from the frozen snapshots, in AUTHORED order and paragraphs; nothing is rewritten.
  // Structure comes from every authored segment (a dropped one still carries its paragraph break), text only from snapshots.
  const structure = answer.units.map(u => unitsById.get(u.id) ?? u);
  const body = assembleSubset(structure, new Set(published));
  // Each obligation stated as unavailable must be covered by a published, verified limitation segment, else fixed copy closes it.
  const limitationCovered = (oid: string) => verdicts.obligations.find(o => o.id === oid)!.coveredByUnits
    .some(u => published.includes(u) && kindOf(u) === 'limitation');
  const uncovered = limitations.filter(oid => !absent.has(oid) || !limitationCovered(oid));
  // Verbatim: the authored reply exactly as written — every segment passed, was approved and is published.
  const verbatim = deterministicFailures === 0 && published.length === sent.length && sent.every(e => published.includes(e.unitId));
  if (!verbatim) reasons.push(reason('REPLY_SEGMENTS_OMITTED', 'publication', false));
  // Incomplete-but-verified recovery: a distinct notice that does NOT say the information is absent from the sources, because it
  // may be present but unverified.
  if (withheld.length) return finish('partial_verified_recovery', `${body}\n\n${VERIFICATION_REMAINING[language]}`, published, [...limitations, ...withheld]);
  const onlyLimitations = published.every(id => kindOf(id) === 'limitation');
  if (limitations.length === verdicts.obligations.length && onlyLimitations)
    return finish('not_in_sources', uncovered.length ? `${body}\n\n${NOT_IN_SOURCES[language]}` : body, published, limitations);
  if (limitations.length) return verbatim && !uncovered.length ? finish('partial_draft', body, published, limitations)
    : finish('partial_units', uncovered.length ? `${body}\n\n${REMAINING[language]}` : body, published, limitations);
  return finish(verbatim ? 'complete_draft' : 'complete_units', body, published);
}
