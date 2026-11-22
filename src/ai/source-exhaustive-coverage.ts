import type { AnswerUnit, Evidence, Facet } from './business-information-answer-plan';
import { resolveEvidenceQuote } from './knowledge-citation';

export const SOURCE_EXHAUSTIVE_PROTOCOL = 'source-exhaustive-v1' as const;
export const SOURCE_EXHAUSTIVE_SCHEMA_NAME = 'odinlink_knowledge_source_exhaustive_v1';
export const SOURCE_EXHAUSTIVE_V2_PROTOCOL = 'source-exhaustive-v2' as const;
export const SOURCE_EXHAUSTIVE_V2_SCHEMA_NAME = 'odinlink_knowledge_source_exhaustive_v2';
export type SourceExhaustiveProtocol = typeof SOURCE_EXHAUSTIVE_PROTOCOL | typeof SOURCE_EXHAUSTIVE_V2_PROTOCOL;
export function isSourceExhaustiveProtocol(value: unknown): value is SourceExhaustiveProtocol {
  return value === SOURCE_EXHAUSTIVE_PROTOCOL || value === SOURCE_EXHAUSTIVE_V2_PROTOCOL;
}
const requestPlanAlignment = 'Request-plan alignment only: the supplied facets and typed obligations faithfully represent the FULL original question, including actor, attribute, modality, scope and conditions. Not factual answer completeness, source availability, or alignment to a narrower source-scoped question. An unavailable but faithfully represented obligation may be aligned and must remain UNRESOLVED.';
const typedUnavailableState = 'Select by the ORIGINAL obligation.questionType, not by the descriptive modality of proposed facts. When requested information is unavailable: description -> REQUESTED_INFORMATION_NOT_VERIFIED; requirement -> UNRESOLVED_REQUIREMENT. These states are not interchangeable. An unresolved requirement means the mandatory rule is unknown, never that no rule exists. Other modalities cannot use either state to gain scoped publication; use UNLOCATED when no supported classification applies. Available omitted facts -> AVAILABLE_SOURCE_FACT_OMITTED; lost conditions -> MISSING_CONDITION. COMPLETE still requires genuinely complete coverage.';
const legacyCompleteness = 'Facet-level answer completeness: false whenever any original obligation in this facet is UNRESOLVED, even if every source-available material fact is preserved. True requires all original obligations fully answered and all material facts preserved.';
const availableCompleteness = 'True when all relevant available material facts and their conditions are preserved in entailed units. Unrequested optional context that cannot affect the answer is not material. Unavailable requested information does not by itself make this false.';
const independentOmission = 'INDEPENDENT_REQUESTED_FACT_OMITTED' as const;
const omissionKinds = ['INDEPENDENT', 'LINKED', 'UNKNOWN'] as const;
const omissionLimits = { records: 6, id: 32, aspect: 90, quote: 600, units: 6 } as const;
const boundedText = (text: unknown, max: number, min = 1): text is string =>
  typeof text === 'string' && text === text.trim() && text.length >= min && text.length <= max;
const assessmentKeys = ['protocol', 'requestAligned', 'availableMaterialFactsComplete', 'conditionsPreserved', 'conflictsAbsent',
  'evidenceIdsReviewed', 'acceptedUnitIdsReviewed', 'obligations'];
const independentOmissionGuidance = `Return sourceCoverage.omissions as {complete,records}. For complete available-source coverage use complete=true and records=[]. Otherwise record each distinct material omission, at most six, and set complete=true only after locating every one. Copy its original obligationId, exact requestedAspect from the customer's question, evidenceId, and exact contiguous source quote. A required qualifier, exception, related procedure step, or anything that changes a retained fact's meaning, conditions, scope, quantity, modality or safety is LINKED. List all affected retained unit IDs. If a dependency or the complete omission inventory is uncertain, use UNKNOWN or complete=false; never guess. Use INDEPENDENT with an empty affectedUnitIds list only when every retained proposition stands on its own in the full source context. If the missing source span cannot be located, leave it out of records and return complete=false.
Use ${independentOmission} only for an unanswered standalone descriptive obligation or a distinct unanswered clause of a single descriptive obligation. For a compound question, copy the entire omitted interrogative clause and record every omitted fact for that clause. Certify that the retained units fully answer every other requested aspect. Do not classify a missing part of the same procedure or policy as a separate question. Keep the legacy row UNRESOLVED with MISSING_RELEVANT_FACT, no obligation unit IDs, and list any independently answered sibling units under materialUnitIds. Every other facet must be a certified independent omission or fully COMPLETE, with all its units in both legacy coverage arrays. Set availableMaterialFactsComplete=false. Use AVAILABLE_SOURCE_FACT_OMITTED for shared or uncertain omissions and MISSING_CONDITION for omitted conditions. Unrequested context that cannot affect the answer does not make either completeness flag false.`;
export const SOURCE_EXHAUSTIVE_V2_EVIDENCE_REVIEW = `Review every supplied evidence item for distinct facts that directly answer or materially qualify the requested offering or decision. A catalog and a description of one offering do not exhaust other sources. For example, a source that says some services are available remotely can materially qualify the range of options even when it does not identify which services. Preserve that general availability as a separately cited proposition where relevant. Keep its original scope and conditions. Do not infer named service mappings, suitability, or intake requirements. Exclude independent logistics unless the question requests them or they are necessary to interpret a relevant fact. For a requested procedure, inventory each distinct material step or condition in the source, including steps performed by the business that directly explain how the requested outcome is handled. Preserve the actor and modality of each step; a business procedure does not impose a customer requirement. Before returning proposals, compare that inventory with the actual unit texts so one supported step does not stand in for another. Items to bring: when the question asks whether or what to bring for a visit, each item the source explicitly says the customer must, should or may bring for that visit is material; give each its own unit with its source modality and conditions. A permitted item is relevant, but it is not a recommendation or requirement, and listed items never establish that nothing else is required. Silence, rules about other conduct and accompanying people are not items to bring.`;
export const SOURCE_COVERAGE_STATES = ['COMPLETE', 'AVAILABLE_SOURCE_FACT_OMITTED', 'REQUESTED_INFORMATION_NOT_VERIFIED',
  'MISSING_CONDITION', 'UNRESOLVED_REQUIREMENT', 'UNLOCATED', independentOmission] as const;
export type SourceShortfall = Readonly<{ facetId: string; obligationId: string; state: typeof SOURCE_COVERAGE_STATES[number]; requestedAspect?: string }>;
export type SourceCoverageAssessment = Readonly<{ state: 'COMPLETE' | 'SCOPED_PARTIAL' | 'DENIED'; unavailable: readonly SourceShortfall[] }>;
const denied: SourceCoverageAssessment = Object.freeze({ state: 'DENIED', unavailable: Object.freeze([]) });
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: readonly string[]): boolean => Array.isArray(a) && a.every(x => typeof x === 'string') &&
  new Set(a).size === a.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const keys = (v: any, expected: string[]) => object(v) && same(Object.keys(v), expected);

/** The legacy verdict is retained verbatim. This separate, explicitly versioned
 * assessment certifies available-source coverage, never complete policy or an
 * answered obligation. Diagnostic witnesses alone cannot supply this certificate. */
export function sourceExhaustiveSchema(base: any, protocol: SourceExhaustiveProtocol = SOURCE_EXHAUSTIVE_PROTOCOL) {
  const str = { type: 'string' }, bool = { type: 'boolean' };
  const alignment = protocol === SOURCE_EXHAUSTIVE_V2_PROTOCOL ? { ...bool, description: requestPlanAlignment } : bool;
  const bounded = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength });
  const strict = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
  const omissions = strict({ complete: bool, records: { type: 'array', maxItems: omissionLimits.records, items: strict({
    obligationId: bounded(omissionLimits.id), requestedAspect: bounded(omissionLimits.aspect, 8),
    evidenceId: bounded(omissionLimits.id), exactQuote: bounded(omissionLimits.quote),
    classification: { type: 'string', enum: omissionKinds },
    affectedUnitIds: { type: 'array', maxItems: omissionLimits.units, items: bounded(omissionLimits.id) },
  }) } });
  const assessment = strict({
    protocol: { type: 'string', enum: [protocol] }, requestAligned: alignment,
    availableMaterialFactsComplete: protocol === SOURCE_EXHAUSTIVE_V2_PROTOCOL ? { ...bool, description: availableCompleteness } : bool, conditionsPreserved: bool, conflictsAbsent: bool,
    evidenceIdsReviewed: { type: 'array', items: str, minItems: 1, maxItems: 6 },
    acceptedUnitIdsReviewed: { type: 'array', items: str, minItems: 1, maxItems: 6 },
    obligations: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false,
      properties: { facetId: str, obligationId: str, state: { type: 'string', enum: SOURCE_COVERAGE_STATES.filter(state => state !== independentOmission || protocol === SOURCE_EXHAUSTIVE_V2_PROTOCOL),
        ...(protocol === SOURCE_EXHAUSTIVE_V2_PROTOCOL ? { description: `${typedUnavailableState} ${independentOmission}: an unanswered descriptive aspect with independently verified omission records.` } : {}) } },
      required: ['facetId', 'obligationId', 'state'] } },
    ...(protocol === SOURCE_EXHAUSTIVE_V2_PROTOCOL ? { omissions } : {}),
  });
  const coverage = protocol === SOURCE_EXHAUSTIVE_V2_PROTOCOL ? { ...base.properties.coverage,
    items: { ...base.properties.coverage.items, properties: { ...base.properties.coverage.items.properties, requestAligned: alignment,
      materialFactsComplete: { ...bool, description: legacyCompleteness } } } }
    : base.properties.coverage;
  return { ...base, properties: { ...base.properties, coverage, sourceCoverage: assessment }, required: [...base.required, 'sourceCoverage'] };
}

export const SOURCE_EXHAUSTIVE_INSTRUCTION = `Source-exhaustive coverage v1. Preserve the existing decisions and coverage fields and assess them independently. Coverage of source-available material facts and resolution of the customer's entire obligation are DIFFERENT judgments. Never mark a broad policy or unsupported requirement COVERED merely because available scoped facts are entailed. Do not repair or relabel an old verdict to gain publication.
Return the separate sourceCoverage assessment. Review EVERY supplied evidence item and authoritative context against EVERY part of the complete question and ALL proposed unit texts. evidenceIdsReviewed and acceptedUnitIdsReviewed must enumerate the entire supplied inventories exactly once. protocol is source-exhaustive-v1. requestAligned requires every original requested obligation and scope to be represented. availableMaterialFactsComplete=true is an explicit independent certification that ALL available, relevant material propositions, recommendations, necessary conditions, exceptions and coordinated restrictions are present in accepted unit texts. It does NOT mean that unavailable requested information is known. conditionsPreserved and conflictsAbsent must independently be true; missing conditions or conflicting applicable sources fail closed. Do not certify completeness from unit entailment, lack of an identified example, or a diagnostic witness alone.
Return exactly one sourceCoverage.obligations row per original obligation, with unchanged IDs. COMPLETE requires an actually fully answered obligation and consistent complete legacy coverage. AVAILABLE_SOURCE_FACT_OMITTED means a relevant available source proposition is missing from the accepted answer. MISSING_CONDITION means a necessary condition, scope restriction or exception is missing. Both prevent scoped publication. REQUESTED_INFORMATION_NOT_VERIFIED means a requested descriptive attribute or broad policy cannot be established from the supplied sources despite exhaustive preservation of available material facts. UNRESOLVED_REQUIREMENT means the requested mandatory rule is not verified; it does not mean that no such rule exists. Use UNLOCATED if this distinction cannot be made reliably; uncertainty about source-exhaustiveness must never authorize publication.
Keep incomplete obligations UNRESOLVED in the legacy coverage. NONE/COVERED remains reserved for genuine complete coverage. A legacy MISSING_RELEVANT_FACT label cannot establish source omission or unavailability by itself; the separate explicit certification and per-obligation states must distinguish them. Never override a missing condition, rejected fact, conflict or unsupported claim. The backend alone binds fresh sources, renders scoped limitations and grants or denies authority. Return only decisions, coverage and sourceCoverage.`;

/** New producer contract only. V1 captures and all false alignment vetoes remain
 * unchanged; the backend must never relabel a returned false verdict. */
export const SOURCE_EXHAUSTIVE_V2_INSTRUCTION = SOURCE_EXHAUSTIVE_INSTRUCTION
  .replace('Source-exhaustive coverage v1.', 'Source-exhaustive coverage v2.')
  .replace('protocol is source-exhaustive-v1. requestAligned requires every original requested obligation and scope to be represented.',
    `protocol is source-exhaustive-v2. ${requestPlanAlignment}`) + `
Alignment definitions for this version: coverage[].requestAligned and sourceCoverage.requestAligned BOTH judge the supplied REQUEST PLAN against the original question, not the factual response against the question. Set false for an omitted requested aspect, wrong subject, changed modality, lost condition, or narrowed scope. Do not set false solely because a faithfully represented obligation has no supported factual unit, its requested information is unavailable, or its mandatory rule remains unresolved. Never force true: if the plan is unfaithful or you cannot establish alignment, return false and publication stays denied.
Keep three judgments separate: (1) plan alignment as defined above; (2) each unit's direct factual relevance to the actual request, judged independently by decisions[].relevant with all existing entailment checks; (3) whether the original obligation is actually fully answered, judged only by coverage completeness and COVERED/UNRESOLVED. True plan alignment cannot authorize irrelevant but true facts, replace a requested attribute with a nearby known attribute, or narrow a broad request to what the sources happen to establish.
The supplied unit texts are factual proposals, not the complete rendered response. Backend limitation disclosures are generated AFTER verification from your original obligation IDs and unavailable states. Their absence from factual units is not a planning omission. Do not invent a factual uncertainty unit or assert that an unseen disclosure has already been verified. REQUESTED_INFORMATION_NOT_VERIFIED and UNRESOLVED_REQUIREMENT must accurately identify unavailable original requested information, never an available fact omitted from the answer. The backend must still render an explicit correctly scoped limitation before publication; all missing-source-fact, condition, conflict, entailment and freshness vetoes remain in force.
Cross-check the reason for incomplete coverage across both blocks. coverage[].materialFactsComplete and sourceCoverage.availableMaterialFactsComplete have distinct meanings. Legacy flag: ${legacyCompleteness} Independent certificate: ${availableCompleteness}
${SOURCE_EXHAUSTIVE_V2_EVIDENCE_REVIEW}
For each facet, cross-check all original obligation IDs before choosing its legacy flag. Judge unit rejection separately from source omission. A rejected unit is not itself proof of a missing material source fact. Use AVAILABLE_SOURCE_FACT_OMITTED and set availableMaterialFactsComplete=false only when you can identify a distinct source-supported proposition material to the original obligation that is absent from the accepted texts. This can include a rejected unit only if the correctly scoped source proposition is independently established as material and missing. If you cannot determine the shortfall, use UNLOCATED. Never use an unavailable-information state to hide a rejected proposal or a known omission. If only requested information is unavailable and every available material fact is present, use legacy UNRESOLVED and the matching typed unavailable state. An unavailable sibling never excuses an omitted available fact. In a compound obligation, judge each requested aspect before selecting its state. An available general description does not establish a specific service's suitability or the information a business requires to assess it.
Typed sourceCoverage.obligations state contract: ${typedUnavailableState} Look up each unchanged obligationId in the supplied facets[].obligations and retain its questionType. Exhaustively verified descriptive facts can coexist with an unresolved mandatory requirement: they do not change its type. For an unavailable requirement, preserve legacy status UNRESOLVED with no supporting rule unitIds and certify UNRESOLVED_REQUIREMENT. Never use a descriptive unavailable state merely because all accepted facts have descriptive modality. The backend independently validates the original obligation modality against the returned state and rejects a mismatch without reclassification.
For a proved independent omission, use the following narrowly scoped exception to whole-answer completeness. ${independentOmissionGuidance}`;

export function sourceExhaustiveInstruction(protocol: SourceExhaustiveProtocol): string {
  return protocol === SOURCE_EXHAUSTIVE_V2_PROTOCOL ? SOURCE_EXHAUSTIVE_V2_INSTRUCTION : SOURCE_EXHAUSTIVE_INSTRUCTION;
}

/** GUARD_12, scoped to the facets that are actually unavailable. A scoped
 * partial may publish a recommendation, permission or requirement only when it
 * cannot be read as the answer to an unavailable obligation:
 * - every facet the unit belongs to is COMPLETE (independently verified), or
 * - it is an affirmative (not negated) verified recommendation, permission or
 *   requirement beside facets whose only gaps are typed UNRESOLVED_REQUIREMENT,
 *   which always render that requirement's limitation notice. GUARD_11 forbids
 *   citing it as coverage of the unresolved requirement and GUARD_10 forbids a
 *   permitted/recommended fact from completing one, so optional-item evidence
 *   can never establish that something is, or is not, required.
 * - in a compound descriptive facet, an affirmative recommendation may stand
 *   beside a distinct, source-bound omission certified independent of all units.
 * Negated non-descriptive facts and prohibitions beside a gap stay blocked.
 * Validated against the independent Phase 2 corpus (incl. recorded rep-04). */
export function scopedPartialModalityBlocked(units: readonly AnswerUnit[], unavailable: readonly Pick<SourceShortfall, 'facetId' | 'state' | 'requestedAspect'>[]): boolean {
  if (!unavailable.length) return false;
  const gaps = new Map<string, Set<string>>();
  for (const gap of unavailable) gaps.set(gap.facetId, (gaps.get(gap.facetId) ?? new Set()).add(gap.state));
  const boundOmissions = new Set(unavailable.filter(gap => gap.state === independentOmission && gap.requestedAspect).map(gap => gap.facetId));
  return units.some(u => {
    if (u.modality === 'descriptive') return false;
    const unresolved = u.facetIds.filter(id => gaps.has(id));
    if (!unresolved.length) return false;
    // The compound request still has an unanswered part. Only affirmative
    // recommendations may share that facet with a source-bound independent gap.
    if (u.modality === 'recommended' && u.negation === false &&
        unresolved.every(id => boundOmissions.has(id) && gaps.get(id)?.size === 1)) return false;
    return !((u.modality === 'permitted' || u.modality === 'recommended' || u.modality === 'required') && u.negation === false &&
      unresolved.every(id => [...gaps.get(id)!].every(state => state === 'UNRESOLVED_REQUIREMENT')));
  });
}

export function sourceCoverageShapeValid(value: any, protocol: SourceExhaustiveProtocol): boolean {
  // Older complete or unavailable-only certificates have no material omission records.
  const extended = protocol === SOURCE_EXHAUSTIVE_V2_PROTOCOL && object(value) && Object.hasOwn(value, 'omissions');
  return keys(value, extended ? [...assessmentKeys, 'omissions'] : assessmentKeys);
}

// A compound omission must identify a whole interrogative, with a separate
// interrogative still present in the original obligation. Entailment and the
// verifier's dependency assessment remain mandatory.
function standaloneCompoundAspect(description: string, aspect: string): boolean {
  const clauses = description.split(/(?<=[.!?؟])\s+|\s+(?:and|och|und|y|و)\s+/iu);
  const interrogative = /^(?:¿?(?:how|what|where|when|who|which|hur|vad|var|när|vem|vilken|vilket|vilka|wie|was|wo|wann|wer|welche[rs]?|cómo|qué|dónde|cuándo|quién|cuál)\s|(?:کجا|چگونه|چه|چقدر|کی|هل|أين|كيف|متى|ما|كم)\s)/iu;
  return clauses.includes(aspect) && interrogative.test(aspect) &&
    clauses.some(clause => clause !== aspect && interrogative.test(clause));
}

export function sourceCoverageCompletenessAllowed(
  assessment: { availableMaterialFactsComplete?: unknown; obligations?: unknown; omissions?: unknown },
  facets: readonly Facet[], units: readonly AnswerUnit[], evidence: readonly Evidence[],
  protocol: SourceExhaustiveProtocol, question?: string,
): boolean {
  const rows = assessment.obligations;
  const omissions = assessment.omissions as { complete?: unknown; records?: unknown } | undefined;
  if (omissions !== undefined && (!keys(omissions, ['complete', 'records']) || omissions?.complete !== true ||
      !Array.isArray(omissions.records) || omissions.records.length > omissionLimits.records)) return false;
  if (assessment.availableMaterialFactsComplete === true)
    return (!omissions || (omissions.records as unknown[]).length === 0) &&
      (!Array.isArray(rows) || !rows.some(row => row?.state === independentOmission));
  if (protocol !== SOURCE_EXHAUSTIVE_V2_PROTOCOL || assessment.availableMaterialFactsComplete !== false ||
      !question || !Array.isArray(omissions?.records) || !omissions.records.length ||
      !facets.every(facet => facet.obligations.length === 1) || !Array.isArray(rows) ||
      !rows.every(row => row?.state === 'COMPLETE' || row?.state === independentOmission)) return false;

  const gaps = rows.filter(row => row.state === independentOmission);
  const aspects = new Map<string, string>();
  const cited = new Set<string>();
  for (const omission of omissions.records) {
    if (!keys(omission, ['obligationId', 'requestedAspect', 'evidenceId', 'exactQuote', 'classification', 'affectedUnitIds']) ||
        !boundedText(omission.obligationId, omissionLimits.id) || !boundedText(omission.requestedAspect, omissionLimits.aspect, 8) ||
        !boundedText(omission.evidenceId, omissionLimits.id) || !boundedText(omission.exactQuote, omissionLimits.quote) ||
        omission.classification !== 'INDEPENDENT' || !same(omission.affectedUnitIds, [])) return false;
    const gap = gaps.find(row => row.obligationId === omission.obligationId);
    if (!gap) return false;
    const obligation = facets.find(facet => facet.id === gap.facetId)?.obligations.find(o => o.id === omission.obligationId);
    const aspect = omission.requestedAspect;
    if (obligation?.questionType !== 'description' || resolveEvidenceQuote(question, aspect).quote !== aspect ||
        resolveEvidenceQuote(obligation.description, aspect).quote !== aspect) return false;
    if (facets.length === 1 ? !standaloneCompoundAspect(obligation.description, aspect) : aspect !== obligation.description) return false;
    const item = evidence.find(e => e.id === omission.evidenceId);
    if (!item) return false;
    const { quote, start, end } = resolveEvidenceQuote(item.text, omission.exactQuote);
    if (quote !== omission.exactQuote || start === undefined || end === undefined ||
        item.citationRanges && !item.citationRanges.some(span => start >= span.start && end <= span.end)) return false;
    const key = JSON.stringify([item.id, start, end]);
    const overlaps = units.some(unit => unit.evidenceRefs.some(ref => {
      if (ref.evidenceId !== item.id) return false;
      const bound = resolveEvidenceQuote(item.text, ref.exactQuote);
      return bound.start === undefined || bound.end === undefined || start < bound.end && end > bound.start;
    }));
    if (cited.has(key) || aspects.has(gap.obligationId) && aspects.get(gap.obligationId) !== aspect || overlaps) return false;
    cited.add(key);
    aspects.set(gap.obligationId, aspect);
  }
  return same([...aspects.keys()], gaps.map(row => row.obligationId));
}

/** Called after the shared omission validator has bound the request and evidence. */
export function omissionRequestedAspect(assessment: any, obligationId: string): string | undefined {
  return assessment.omissions?.records?.find((row: any) => row.obligationId === obligationId)?.requestedAspect;
}

export function independentSourceOmissionAllowed(
  state: unknown, questionType: Facet['questionType'], reason: unknown, materialUnitIds: unknown,
  obligationUnitIds: unknown, validIds: readonly string[], compound: boolean,
): boolean {
  return state === independentOmission && questionType === 'description' && reason === 'MISSING_RELEVANT_FACT' &&
    same(obligationUnitIds, []) && same(materialUnitIds, validIds) && (compound || validIds.length === 0);
}

/** Pure contract assessment. No tenant enrolment, model invocation, rendering or
 * authority minting. All independent judgments and identities must agree. */
export function assessSourceCoverage(raw: any, facets: readonly Facet[], units: readonly AnswerUnit[],
  evidence: readonly Evidence[], businessId: number | undefined,
  protocol: SourceExhaustiveProtocol = SOURCE_EXHAUSTIVE_PROTOCOL, question?: string): SourceCoverageAssessment {
  const coverageDenied = (guard: string): SourceCoverageAssessment => {
    if (process.env.ODINLINK_KNOWLEDGE_COVERAGE_DIAGNOSTICS === '1') {
      console.warn('[SourceCoverageDenied]', JSON.stringify({
        protocol, guard
      }));
    }
    return denied;
  };
  if (!isSourceExhaustiveProtocol(protocol)) return coverageDenied('GUARD_01');
  if (!Number.isSafeInteger(businessId) || businessId! <= 0 || !facets.length || facets.length > 4 || !units.length || units.length > 6 ||
    !evidence.length || evidence.length > 6 || evidence.some(e => e.businessId !== businessId ||
      [e.id, e.sourceId, e.chunkId, e.version, e.text].some(x => typeof x !== 'string' || !x.trim()) || e.text.length > 2400) ||
    new Set(evidence.map(e => e.id)).size !== evidence.length || new Set(evidence.map(e => JSON.stringify([e.sourceId, e.chunkId]))).size !== evidence.length ||
    new Set(units.map(u => u.id)).size !== units.length) return coverageDenied('GUARD_02');
  if (!keys(raw, ['decisions', 'coverage', 'sourceCoverage'])) return coverageDenied('GUARD_03');
  const s = raw.sourceCoverage;
  if (!sourceCoverageShapeValid(s, protocol) || s.protocol !== protocol ||
    s.requestAligned !== true || !sourceCoverageCompletenessAllowed(s, facets, units, evidence, protocol, question) || s.conditionsPreserved !== true || s.conflictsAbsent !== true ||
    !same(s.evidenceIdsReviewed, evidence.map(e => e.id)) || !same(s.acceptedUnitIdsReviewed, units.map(u => u.id))) return coverageDenied('GUARD_04');
  if (!Array.isArray(raw.decisions) || raw.decisions.length !== units.length || !same(raw.decisions.map((d: any) => d?.unitId), units.map(u => u.id))) return coverageDenied('GUARD_05');
  for (const u of units) {
    const d = raw.decisions.find((d: any) => d.unitId === u.id);
    if (!u.facetIds.length || !u.facetIds.every(id => facets.some(f => f.id === id)) || d.relation !== 'ENTAILED' ||
      !same(d.facetIds, u.facetIds) || ['meaningPreserved', 'modalityPreserved', 'qualifiersPreserved', 'relevant', 'languageCorrect'].some(k => d[k] !== true) ||
      typeof d.negativeAbsence !== 'boolean' || typeof d.explicitAbsenceEvidence !== 'boolean' || d.negativeAbsence && !d.explicitAbsenceEvidence ||
      !u.evidenceRefs.length || u.evidenceRefs.some(r => !evidence.some(e => e.id === r.evidenceId && e.sourceId === r.sourceId &&
        e.chunkId === r.chunkId && e.version === r.version && e.text.includes(r.exactQuote)))) return coverageDenied('GUARD_06');
  }
  const obligations = facets.flatMap(f => f.obligations.map(o => ({ f, o })));
  if (!Array.isArray(s.obligations) || s.obligations.length !== obligations.length || !same(s.obligations.map((o: any) => o?.obligationId), obligations.map(({ o }) => o.id)) ||
    !Array.isArray(raw.coverage) || raw.coverage.length !== facets.length || !same(raw.coverage.map((c: any) => c?.facetId), facets.map(f => f.id))) return coverageDenied('GUARD_07');
  const unavailable: SourceShortfall[] = [];
  for (const f of facets) {
    const c = raw.coverage.find((c: any) => c.facetId === f.id), validIds = units.filter(u => u.facetIds.includes(f.id)).map(u => u.id);
    const subset = (ids: any) => Array.isArray(ids) && ids.every(id => typeof id === 'string' && validIds.includes(id)) && new Set(ids).size === ids.length;
    if (!keys(c, ['facetId', 'requestAligned', 'materialFactsComplete', 'incompletenessReason', 'materialUnitIds', 'obligations']) || c.requestAligned !== true ||
      typeof c.materialFactsComplete !== 'boolean' || !['NONE', 'UNRESOLVED', 'MISSING_RELEVANT_FACT'].includes(c.incompletenessReason) ||
      !subset(c.materialUnitIds) || !Array.isArray(c.obligations) || c.obligations.length !== f.obligations.length ||
      !same(c.obligations.map((o: any) => o?.obligationId), f.obligations.map(o => o.id))) return coverageDenied('GUARD_08');
    for (const o of f.obligations) {
      const d = c.obligations.find((d: any) => d.obligationId === o.id), a = s.obligations.find((a: any) => a.obligationId === o.id);
      if (!keys(d, ['obligationId', 'status', 'unitIds']) || !subset(d.unitIds) || !keys(a, ['facetId', 'obligationId', 'state']) || a.facetId !== f.id) return coverageDenied('GUARD_09');
      if (a.state === 'COMPLETE') {
        const covers = o.questionType === 'description' || units.some(u => d.unitIds.includes(u.id) &&
          (o.questionType === 'permission' ? u.modality === 'permitted' || u.modality === 'prohibited' && !u.negation :
            u.modality === ({ requirement: 'required', recommendation: 'recommended', prohibition: 'prohibited' } as const)[o.questionType]));
        if (!covers || !c.materialFactsComplete || c.incompletenessReason !== 'NONE' || d.status !== 'COVERED' || !d.unitIds.length ||
          !c.materialUnitIds.length || s.availableMaterialFactsComplete === false &&
            (!same(d.unitIds, validIds) || !same(c.materialUnitIds, validIds))) return coverageDenied('GUARD_10');
      } else {
        if (d.status !== 'UNRESOLVED' || c.materialFactsComplete || c.incompletenessReason === 'NONE' ||
          o.questionType === 'requirement' && d.unitIds.length !== 0 ||
          !(a.state === 'REQUESTED_INFORMATION_NOT_VERIFIED' && o.questionType === 'description' || a.state === 'UNRESOLVED_REQUIREMENT' && o.questionType === 'requirement' ||
            independentSourceOmissionAllowed(a.state, o.questionType, c.incompletenessReason,
              c.materialUnitIds, d.unitIds, validIds, facets.length === 1))) return coverageDenied('GUARD_11');
        unavailable.push(Object.freeze({ facetId: f.id, obligationId: o.id, state: a.state,
          ...(a.state === independentOmission ? { requestedAspect: omissionRequestedAspect(s, o.id) } : {}) }));
      }
    }
  }
  if (scopedPartialModalityBlocked(units, unavailable)) return coverageDenied('GUARD_12');
  return Object.freeze({ state: unavailable.length ? 'SCOPED_PARTIAL' : 'COMPLETE', unavailable: Object.freeze(unavailable) });
}
