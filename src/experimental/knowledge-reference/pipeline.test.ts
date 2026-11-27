/**
 * EXPERIMENTAL — offline validation of the Knowledge Answer reference path.
 * Scripted providers only: no network, no paid calls, no production module is exercised.
 * Each scripted verifier states the verdict it returns; the assertions test the PIPELINE's decision, not model quality.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUnit, customerSuppliedNumbers, runReferenceAnswer, type ReferenceOptions } from './pipeline';
import { pinCorpus } from './corpus';
import { VERIFIER_INSTRUCTIONS } from './prompts';
import { REASON_CODES, type ReasonCode } from './reasons';
import { FALLBACK, NOT_IN_SOURCES, REMAINING, VERIFICATION_REMAINING } from './localization';
import { ANSWER_SCHEMA, ANSWER_SCHEMA_NAME } from './contracts';
import { REDACTION } from './secrets';
import { loadDataset, loadFixtureSources } from './eval/dataset';
import { approvingVerifier, currentRevalidation, renderedPassages, revisions, scriptedProvider, sentUnits, USAGE, type Script } from './eval/scripted';
import type { AnswerOutput, AnswerUnit, Language, ProviderRequest, ReferenceResult, SourceRecord, VerifierOutput } from './types';

const dataset = loadDataset();
const sources = loadFixtureSources();
const rev = revisions(sources);
const caseById = (id: string) => dataset.cases.find(c => c.id === id)!;
const cite = (fact: string, quote?: string) => {
  const f = dataset.facts[fact];
  return { sourceId: f.sourceId, revision: rev[f.sourceId], quote: quote ?? f.quote };
};
const unit = (id: string, text: string, modality: AnswerUnit['modality'], facts: string[], conditions: string[] = []): AnswerUnit =>
  ({ id, text, modality, conditions, citations: facts.map(f => cite(f)), addresses: [] });

async function run(caseId: string, script: Script, extra: Partial<ReferenceOptions> & { sources?: SourceRecord[]; language?: Language } = {}) {
  const c = caseById(caseId);
  const calls: ProviderRequest[] = [];
  const result = await runReferenceAnswer({ businessId: 3, question: c.question, language: extra.language ?? c.language, history: c.history,
    sources: extra.sources ?? sources }, { provider: scriptedProvider(script, calls), revalidate: extra.revalidate ?? currentRevalidation(sources),
    timeouts: extra.timeouts ?? { answerMs: 2000, verifierMs: 2000 } });
  invariants(result, typeof script.answer === 'object' ? script.answer as AnswerOutput : undefined, c.language);
  return { result, calls };
}
const codes = (r: ReferenceResult) => r.reasons.map(x => x.code);
const sentUnitsCount = (calls: ProviderRequest[]) => sentUnits(calls.find(c => c.role === 'verifier')!).length;
const fatal = (r: ReferenceResult) => r.reasons.filter(x => x.fatal).map(x => x.code);
/** Verified partial recovery: the failing obligation is withheld ENTIRELY, nothing rejected is published, the notice does not claim absence. */
function assertRecovery(r: ReferenceResult, codesExpected: string[], mustNotPublish: string[], answer?: AnswerOutput) {
  assert.equal(r.publication, 'partial_verified_recovery', JSON.stringify(r.reasons));
  assert.deepEqual(fatal(r), []);
  assert.deepEqual(r.reasons.filter(x => x.stage === 'coverage' && ['AVAILABLE_SOURCE_FACT_OMITTED', 'OBLIGATION_INCOMPLETE', 'VERIFIER_OBLIGATION_INCONSISTENT'].includes(x.code)).map(x => x.code), codesExpected);
  assert.ok(r.text.endsWith(VERIFICATION_REMAINING.sv) || Object.values(VERIFICATION_REMAINING).some(t => r.text.endsWith(t)));
  for (const id of mustNotPublish) {
    assert.ok(!r.publishedUnitIds.includes(id), `withheld unit ${id} published`);
    const text = answer?.units.find(u => u.id === id)?.text;
    if (text) assert.ok(!r.text.includes(text), `withheld text of ${id} leaked`);
  }
}

/** Properties that must hold for every result. */
function invariants(r: ReferenceResult, answer: AnswerOutput | undefined, language: Language) {
  for (const x of r.reasons) assert.ok((REASON_CODES as readonly string[]).includes(x.code), `unknown code ${x.code}`);
  if (r.publication === 'fallback') {
    assert.equal(r.text, FALLBACK[language]);
    assert.ok(r.reasons.some(x => x.fatal), 'fallback without a fatal reason code');
    assert.equal(r.publishedUnitIds.length, 0);
  } else assert.ok(!r.reasons.some(x => x.fatal), 'publication with a fatal reason');
  if (answer) {
    const byId = new Map(answer.units.map(u => [u.id, u]));
    // Protocol v3: published text is exactly the published segments, in AUTHORED order, plus fixed copy; nothing else.
    if (r.publication !== 'fallback' && r.publication !== 'not_in_sources' || r.publishedUnitIds.length) {
      const authored = answer.units.filter(u => r.publishedUnitIds.includes(u.id)).map(u => u.text.trim());
      let at = 0;
      for (const t of authored) { const i = r.text.indexOf(t, at); assert.ok(i >= at, `published segment out of order or rewritten: ${t}`); at = i + t.length; }
      const rest = authored.reduce((x, t) => x.replace(t, ''), r.text).replace(/\s+/gu, ' ').trim();
      const fixed = [REMAINING[language], VERIFICATION_REMAINING[language], NOT_IN_SOURCES[language]];
      assert.ok(rest === '' || fixed.includes(rest), `text beyond the published segments: ${rest}`);
    }
    if (r.publication === 'partial_verified_recovery') assert.ok(r.text.endsWith(`\n\n${VERIFICATION_REMAINING[language]}`));
    for (const u of answer.units) if (!r.publishedUnitIds.includes(u.id) && !answer.units.some(x => r.publishedUnitIds.includes(x.id) && x.text.includes(u.text)))
      assert.ok(!r.text.includes(u.text.trim()), `unpublished segment ${u.id} leaked`);
    for (const u of r.trace.units) if (!u.approved && r.publication !== 'fallback')
      assert.ok(r.reasons.some(x => x.unitId === u.id), `unit ${u.id} dropped without a reason`);
  }
}

// ---------------- sv-01: the exact failed Telegram question ----------------
const SV01_DRAFT = 'Välkommen! Inför ditt första besök rekommenderas du att komma cirka 10 minuter före din bokade tid. Det är en rekommendation och inte ett krav. ' +
  'Entrén ligger på innergården, inte vid huvudingången mot gatan: använd porten märkt Aurora 7 och följ de blå skyltarna till receptionen på andra våningen.';
const sv01Units = (): AnswerUnit[] => [
  unit('u1', 'Om det är ditt första besök rekommenderas du att komma cirka 10 minuter före din bokade tid.', 'recommended', ['ARRIVE_10'], ['gäller förstagångsbesökare']),
  unit('u2', 'Entrén ligger på innergården, inte vid huvudingången mot gatan.', 'descriptive', ['ENTRANCE_COURTYARD']),
  unit('u3', 'Använd porten märkt Aurora 7 och följ sedan de blå skyltarna till receptionen på andra våningen.', 'required', ['GATE_AURORA']),
  unit('u4', 'Det är en rekommendation för förstagångsbesökare, inte ett obligatoriskt krav eller en sista ankomsttid.', 'recommended', ['ARRIVE_NOT_MANDATORY']),
];
const sv01Answer = (units = sv01Units(), draft = SV01_DRAFT): AnswerOutput => ({ language: 'sv', draft, units,
  obligations: [{ id: 'a1', description: 'ankomsttid', status: 'answered' }, { id: 'a2', description: 'entré', status: 'answered' }, { id: 'a3', description: 'krav', status: 'answered' }] });
const sv01Obligations = (sent: readonly { id: string }[]): VerifierOutput['obligations'] => {
  const has = (id: string) => sent.some(u => u.id === id);
  const ob = (id: string, kind: VerifierOutput['obligations'][number]['kind'], units: string[]) => ({ id, description: id, kind, availableInSources: true,
    sourcesConflict: false, conflictingQuotes: [], status: units.every(has) ? 'complete' as const : 'not_addressed' as const, coveredByUnits: units.filter(has),
    missingInformation: units.every(has) ? [] : ['relevant source fact not in units'] });
  return [ob('v1', 'recommendation', ['u1']), ob('v2', 'location', ['u2', 'u3']), ob('v3', 'requirement', ['u4'])];
};

test('sv-01: fully verified answer publishes the authored reply verbatim (protocol v3: the segments, written once)', async () => {
  const { result, calls } = await run('sv-01', { answer: sv01Answer(), verifier: approvingVerifier(sv01Obligations) });
  assert.equal(result.publication, 'complete_draft');
  assert.equal(result.text, sv01Units().map(u => u.text).join(' '));
  assert.deepEqual([...result.publishedUnitIds], ['u1', 'u2', 'u3', 'u4']);
  assert.equal(calls.length, 2, 'exactly two model calls');
  assert.equal(result.metrics.stages.length, 2);
  assert.ok(result.metrics.stages.every(s => s.requestBytes > 0 && s.usage && s.costUsd! > 0));
  assert.ok(Math.abs(result.metrics.costUsd! - 2 * (USAGE.inputTokens * 2 + USAGE.outputTokens * 10) / 1e6) < 1e-12);
});

test('verifier is independent: it receives the question and units, never the answerer\'s obligation list', async () => {
  const answer = sv01Answer();
  const marked = { ...answer, obligations: answer.obligations.map(o => ({ ...o, description: `ANSWERER-INTERPRETATION-${o.id}` })) };
  const { calls } = await run('sv-01', { answer: marked, verifier: approvingVerifier(sv01Obligations) });
  const verifier = calls.find(c => c.role === 'verifier')!;
  assert.ok(!verifier.input.includes('ANSWERER-INTERPRETATION'));
  assert.ok(verifier.input.includes(caseById('sv-01').question));
  assert.ok(!verifier.instructions.includes('ANSWERER'));
});

test('protocol v3: there is no separate draft — content outside the segments cannot be sent, verified or published', async () => {
  const { result, calls } = await run('sv-01', { answer: sv01Answer(sv01Units(), 'Välkommen! Parkeringen är DRAFT-ONLY-CLAIM. ' + SV01_DRAFT),
    verifier: approvingVerifier(sv01Obligations) });
  const answerCall = calls.find(c => c.role === 'answer')!;
  assert.equal(answerCall.schemaName, ANSWER_SCHEMA_NAME);
  assert.ok(!('draft' in (ANSWER_SCHEMA as any).properties) && 'reply' in (ANSWER_SCHEMA as any).properties);
  assert.ok(!result.text.includes('DRAFT-ONLY-CLAIM') && !result.text.includes('Välkommen'));
  assert.ok(!calls.find(c => c.role === 'verifier')!.input.includes('DRAFT-ONLY-CLAIM'));
  assert.ok(!answerCall.input.includes('DRAFT-ONLY-CLAIM'));
});

test('a whole-reply judgment remains: segments that mislead when read together stop the turn (VERIFIER_REPLY_MISLEADING)', async () => {
  const { result } = await run('sv-01', { answer: sv01Answer(), verifier: approvingVerifier(sv01Obligations, { misleadingAsWhole: true }) });
  assert.deepEqual(fatal(result), ['VERIFIER_REPLY_MISLEADING']);
});

// ---------------- customer-visible completeness (2026-11-25, Pilot 5 sv-08 class) ----------------
const LATE_TEXT_NO_THRESHOLD = 'Om du blir 20 minuter sen kan vi behöva bedöma på nytt om besöket kan genomföras enligt plan.';
test('a threshold present only in the conditions metadata is refused deterministically (CONDITION_NOT_IN_TEXT), never published as complete', async () => {
  const answer: AnswerOutput = { language: 'sv', draft: '', obligations: [{ id: 'a1', description: 'sen', status: 'answered' }],
    units: [unit('l1', LATE_TEXT_NO_THRESHOLD, 'descriptive', ['LATE_15'], ['Vid en försening på mer än 15 minuter.'])] };
  const { result, calls } = await run('sv-08', { answer, verifier: approvingVerifier(s => [{ id: 'v1', description: 'late', kind: 'information',
    availableInSources: true, sourcesConflict: false, status: 'complete', coveredByUnits: s.map(u => u.id), missingInformation: [] }]) });
  assert.ok(result.reasons.some(r => r.code === 'CONDITION_NOT_IN_TEXT' && r.unitId === 'l1' && r.detail === 'number:15'));
  assert.ok(!result.text.includes(LATE_TEXT_NO_THRESHOLD));
  assert.notEqual(result.publication, 'complete_draft');
  assert.notEqual(result.publication, 'complete_units');
  assert.equal(sentUnitsCount(calls), 0, 'the unit never reaches the verifier');
});

test('the same threshold written in the customer-visible text passes; the verifier never receives the conditions metadata', async () => {
  const text = 'Vid en försening på mer än 15 minuter kan vi behöva bedöma på nytt om besöket kan genomföras enligt plan.';
  const answer: AnswerOutput = { language: 'sv', draft: '', obligations: [{ id: 'a1', description: 'sen', status: 'answered' }],
    units: [unit('l1', text, 'descriptive', ['LATE_15'], ['METADATA-ONLY-CONDITION mer än 15 minuter'])] };
  const { result, calls } = await run('sv-08', { answer, verifier: approvingVerifier(s => [{ id: 'v1', description: 'late', kind: 'information',
    availableInSources: true, sourcesConflict: false, status: 'complete', coveredByUnits: s.map(u => u.id), missingInformation: [] }]) });
  assert.equal(result.publication, 'complete_draft', JSON.stringify(result.reasons));
  assert.equal(result.text, text);
  assert.ok(!calls.find(c => c.role === 'verifier')!.input.includes('METADATA-ONLY-CONDITION'), 'metadata reached the verifier');
});

test('numeric fidelity of conditions in every language: a declared numeric condition must appear in the text (digits or number words)', async () => {
  const c = ctx();
  const mk = (text: string, conditions: string[]): AnswerUnit => ({ ...unit('x', text, 'descriptive', ['LATE_15']), conditions });
  assert.equal(checkUnit(mk('Vid mer än femton minuters försening kan besöket behöva bedömas på nytt.', ['mer än 15 minuter']), c, 'sv'), undefined);
  assert.equal(checkUnit(mk('Vid försening kan besöket behöva bedömas på nytt.', ['mer än 15 minuter']), c, 'sv')?.code, 'CONDITION_NOT_IN_TEXT');
  assert.equal(checkUnit(mk('If you are more than 15 minutes late, the visit may need to be reassessed.', ['more than fifteen minutes']), c, 'en'), undefined);
  assert.equal(checkUnit(mk('If you are late, the visit may need to be reassessed.', ['more than fifteen minutes']), c, 'en')?.code, 'CONDITION_NOT_IN_TEXT');
});

// ---------------- deterministic unit checks ----------------
const deterministicCases: [string, (u: AnswerUnit[]) => AnswerUnit[], ReasonCode][] = [
  // Citation protocol v2: the model can no longer state a source id, a revision or a quote, so the v1 attacks (foreign source id, stale
  // revision, edited quote, trivially short quote) become reference attacks. Software resolves and re-checks every reference.
  ['unknown evidence reference', u => [{ ...u[0], evidence: ['E999'] }, ...u.slice(1)], 'EVIDENCE_REF_UNKNOWN'],
  ['one valid and one unknown reference (no partial resolution)', u => [{ ...u[0], evidence: ['E6', 'E4000'] }, ...u.slice(1)], 'EVIDENCE_REF_UNKNOWN'],
  ['reference to a passage that does not state the number (wrong attribution)', u => [{ ...u[0], evidence: ['E15'] }, ...u.slice(1)], 'NUMBER_NOT_IN_CITATION'],
  ['reference to a trivially short passage (a page number)', u => [{ ...u[0], evidence: ['E1'] }, ...u.slice(1)], 'CITATION_QUOTE_TOO_SHORT'],
  ['no citation', u => [{ ...u[0], citations: [], evidence: [] }, ...u.slice(1)], 'UNIT_NO_CITATION'],
  ['wrong number', u => [{ ...u[0], text: 'Om det är ditt första besök rekommenderas du att komma cirka 15 minuter före din bokade tid.' }, ...u.slice(1)], 'NUMBER_NOT_IN_CITATION'],
  ['unit in the wrong language', u => [{ ...u[0], text: 'If this is your first visit, you are recommended to arrive about 10 minutes before your booked time.' }, ...u.slice(1)], 'UNIT_LANGUAGE_MISMATCH'],
];
for (const [name, mutate, code] of deterministicCases) {
  test(`deterministic: ${name} → ${code}; the unit never reaches the verifier and the turn fails closed`, async () => {
    const { result, calls } = await run('sv-01', { answer: sv01Answer(mutate(sv01Units())), verifier: approvingVerifier(sv01Obligations) });
    assert.ok(codes(result).includes(code), `expected ${code}, got ${codes(result)}`);
    const sentToVerifier = calls.find(c => c.role === 'verifier')!.input;
    assert.ok(result.reasons.some(x => x.code === code && x.unitId));
    const rejected = result.reasons.find(x => x.code === code)!.unitId!;
    assert.ok(!sentToVerifier.includes(`"unitId":"${rejected}"`));
    // The obligation's answer exists in the sources: it is withheld entirely; the other, complete obligations are recovered.
    const answer = sv01Answer(mutate(sv01Units()));
    assertRecovery(result, ['AVAILABLE_SOURCE_FACT_OMITTED'], [rejected], answer);
  });
}

test('condition kept: companion unit with its conditions passes and publishes', async () => {
  const answer: AnswerOutput = { language: 'en', draft: '', obligations: [{ id: 'a1', description: 'room', status: 'answered' }],
    units: [unit('c1', 'Companions may not automatically join you in the treatment room; staff must approve it separately.', 'prohibited', ['COMPANION_ROOM'],
      ['not automatically', 'separate staff approval'])] };
  const { result } = await run('en-06', { answer, verifier: approvingVerifier(s => [{ id: 'v1', description: 'room', kind: 'permission', availableInSources: true,
    sourcesConflict: false, status: 'complete', coveredByUnits: s.map(u => u.id), missingInformation: [] }]) });
  assert.equal(result.publication, 'complete_draft', JSON.stringify(result.reasons)); // protocol v3: the segment IS the reply
});

// ---------------- verifier verdicts ----------------
const verdictCases: [string, Partial<VerifierOutput['units'][number]>, ReasonCode][] = [
  ['NOT_ENTAILED', { verdict: 'NOT_ENTAILED' }, 'VERIFIER_NOT_ENTAILED'],
  ['PARTIALLY_ENTAILED', { verdict: 'PARTIALLY_ENTAILED' }, 'VERIFIER_PARTIALLY_ENTAILED'],
  ['CONTRADICTED (contradictory evidence)', { verdict: 'CONTRADICTED' }, 'VERIFIER_CONTRADICTED'],
  ['modality wrong', { modalityCorrect: false }, 'VERIFIER_MODALITY_WRONG'],
  ['conditions dropped', { conditionsPreserved: false }, 'VERIFIER_CONDITIONS_DROPPED'],
  ['unsupported addition', { unsupportedAdditions: ['claims free parking'] }, 'VERIFIER_UNSUPPORTED_ADDITION'],
  ['language wrong', { languageCorrect: false }, 'VERIFIER_LANGUAGE_WRONG'],
];
for (const [name, patch, code] of verdictCases) {
  test(`verifier ${name} on a unit that covers an answerable obligation → unit rejected (${code}) and turn fails closed`, async () => {
    const verifier = (sent: any, dHash: string) => {
      const out = approvingVerifier(sv01Obligations)(sent, dHash);
      return { ...out, units: out.units.map(u => u.unitId === 'u4' ? { ...u, ...patch } : u) };
    };
    const { result } = await run('sv-01', { answer: sv01Answer(), verifier });
    assert.ok(result.reasons.some(x => x.code === code && x.unitId === 'u4'));
    assertRecovery(result, ['OBLIGATION_INCOMPLETE'], ['u4'], sv01Answer());
  });
}

test('verifier finds an obligation the answerer missed (incomplete obligations) → AVAILABLE_SOURCE_FACT_OMITTED', async () => {
  const answer = sv01Answer(sv01Units().slice(0, 3)); // requirement unit omitted
  const { result } = await run('sv-01', { answer, verifier: approvingVerifier(sv01Obligations) });
  assertRecovery(result, ['AVAILABLE_SOURCE_FACT_OMITTED'], ['u4'], answer);
  assert.deepEqual([...result.limitationObligationIds], ['v3']);
});

test('verifier marks an obligation incomplete with missing source information → fail closed even if every unit is entailed', async () => {
  const verifier = (sent: any, dHash: string) => {
    const out = approvingVerifier(sv01Obligations)(sent, dHash);
    return { ...out, obligations: out.obligations.map(o => o.id === 'v2' ? { ...o, status: 'incomplete' as const, missingInformation: ['lift via right side'] } : o) };
  };
  const { result } = await run('sv-01', { answer: sv01Answer(), verifier });
  // Dependency protection: u2 and u3 are ENTAILED but belong to the incomplete obligation, so neither is published.
  assertRecovery(result, ['AVAILABLE_SOURCE_FACT_OMITTED'], ['u2', 'u3'], sv01Answer());
  assert.deepEqual([...result.publishedUnitIds], ['u1', 'u4']);
});

test('unprovable conflict (no verbatim conflicting excerpts) → SOURCE_CONFLICT, whole turn withheld', async () => {
  const verifier = (sent: any, dHash: string) => {
    const out = approvingVerifier(sv01Obligations)(sent, dHash);
    return { ...out, obligations: out.obligations.map(o => o.id === 'v1' ? { ...o, sourcesConflict: true } : o) };
  };
  const { result } = await run('sv-01', { answer: sv01Answer(), verifier });
  assert.deepEqual(fatal(result), ['SOURCE_CONFLICT']);
});

test('interpretation divergence is measured but does not block', async () => {
  const answer = { ...sv01Answer(), obligations: [{ id: 'a1', description: 'allt', status: 'answered' as const }] };
  const { result } = await run('sv-01', { answer, verifier: approvingVerifier(sv01Obligations) });
  assert.equal(result.publication, 'complete_draft');
  assert.ok(result.reasons.some(x => x.code === 'OBLIGATION_INTERPRETATION_DIVERGED' && !x.fatal));
});

test('approved but irrelevant unit is not published and has a reason; draft is not used', async () => {
  const units = [...sv01Units(), unit('u5', 'Det är tillåtet att ta med en egen vattenflaska.', 'permitted', ['WATER'])];
  const { result } = await run('sv-01', { answer: sv01Answer(units), verifier: approvingVerifier(sv01Obligations) });
  assert.equal(result.publication, 'complete_units');
  assert.ok(!result.publishedUnitIds.includes('u5'));
  assert.ok(result.reasons.some(x => x.code === 'UNIT_NOT_RELEVANT' && x.unitId === 'u5'));
});

// ---------------- partial and absent ----------------
test('sv-08 partial without a limitation segment: hours absent, late-arrival verified → approved segments + fixed REMAINING; a scripted draft is never sent', async () => {
  const units = [
    unit('l1', 'Vid en försening på mer än 15 minuter kan studion behöva göra en ny bedömning av om besöket kan genomföras enligt plan.', 'descriptive', ['LATE_15']),
    unit('l2', 'Det innebär inte att besöket avbokas automatiskt, personalen bedömer först situationen.', 'descriptive', ['LATE_NOT_CANCELLED']),
  ];
  const answer: AnswerOutput = { language: 'sv', units, draft: 'Vi har öppet 9–17. ' + units.map(u => u.text).join(' '),
    obligations: [{ id: 'a1', description: 'öppettider', status: 'not_in_sources' }, { id: 'a2', description: 'försening', status: 'answered' }] };
  const { result } = await run('sv-08', { answer, verifier: approvingVerifier(s => [
    { id: 'v1', description: 'hours', kind: 'information', availableInSources: false, sourcesConflict: false, status: 'not_addressed', coveredByUnits: [], missingInformation: [] },
    { id: 'v2', description: 'late', kind: 'information', availableInSources: true, sourcesConflict: false, status: 'complete', coveredByUnits: s.map(u => u.id), missingInformation: [] },
  ]) });
  assert.equal(result.publication, 'partial_units');
  assert.ok(result.text.endsWith(REMAINING.sv));
  assert.ok(!result.text.includes('9–17'), 'unverified draft content leaked');
  assert.deepEqual([...result.limitationObligationIds], ['v1']);
});

test('fa-08 (17 Nov message) partial: requirement not stated in sources → verified items + notice, never "nothing else required"', async () => {
  const units = [
    unit('p1', 'برای اولین مراجعه توصیه می‌شود حدود ۱۰ دقیقه قبل از وقت رزرو برسید.', 'recommended', ['ARRIVE_10'], ['برای اولین مراجعه']),
    unit('p2', 'در صورت تمایل می‌توانید تأییدیه رزرو خود را به صورت دیجیتال یا کاغذی همراه داشته باشید.', 'recommended', ['CONFIRMATION_OPTIONAL']),
    unit('p3', 'اگر دستورالعمل آمادگی خاصی دریافت کرده‌اید، باید آن را رعایت کنید.', 'required', ['SPECIAL_INSTRUCTIONS']),
    unit('p4', 'همراه داشتن بطری آب شخصی مجاز است، اما الزامی نیست.', 'permitted', ['WATER'], ['اختیاری']),
  ];
  const answer: AnswerOutput = { language: 'fa', units, draft: '', obligations: [{ id: 'a1', description: 'زمان', status: 'answered' }, { id: 'a2', description: 'همراه', status: 'partially_answered' }] };
  const { result } = await run('fa-08', { answer, verifier: approvingVerifier(() => [
    { id: 'v1', description: 'arrival', kind: 'recommendation', availableInSources: true, sourcesConflict: false, status: 'complete', coveredByUnits: ['p1'], missingInformation: [] },
    { id: 'v2', description: 'bring', kind: 'requirement', availableInSources: true, sourcesConflict: false, status: 'incomplete', coveredByUnits: ['p2', 'p3', 'p4'], missingInformation: [] },
  ]) });
  assert.equal(result.publication, 'partial_units', JSON.stringify(result.reasons));
  assert.ok(result.text.endsWith(REMAINING.fa));
});

test('sv-07 absent: verifier independently confirms absence → fixed NOT_IN_SOURCES copy', async () => {
  const answer: AnswerOutput = { language: 'sv', units: [], draft: 'Det kan jag tyvärr inte svara på.', obligations: [{ id: 'a1', description: 'pris', status: 'not_in_sources' }] };
  const { result, calls } = await run('sv-07', { answer, verifier: approvingVerifier(() => [{ id: 'v1', description: 'price', kind: 'information',
    availableInSources: false, sourcesConflict: false, status: 'not_addressed', coveredByUnits: [], missingInformation: [] }]) });
  assert.equal(calls.length, 2, 'absence is independently verified');
  assert.equal(result.publication, 'not_in_sources');
  assert.equal(result.text, NOT_IN_SOURCES.sv);
});

test('answerer claims "not in sources" but the verifier finds the answer → AVAILABLE_SOURCE_FACT_OMITTED', async () => {
  const answer: AnswerOutput = { language: 'en', units: [], draft: '', obligations: [{ id: 'a1', description: 'arrival', status: 'not_in_sources' }] };
  const { result } = await run('en-02', { answer, verifier: approvingVerifier(() => [{ id: 'v1', description: 'arrival', kind: 'recommendation',
    availableInSources: true, sourcesConflict: false, status: 'not_addressed', coveredByUnits: [], missingInformation: ['about 10 minutes'] }]) });
  assert.deepEqual(fatal(result), ['AVAILABLE_SOURCE_FACT_OMITTED']);
});

// ---------------- other languages: deterministic checks accept faithful units ----------------
test('fa-04 and ar-04: faithful RTL units pass deterministic checks (digits, ordinals, script)', async () => {
  for (const [caseId, language, texts] of [
    ['fa-04', 'fa', ['ورودی استودیو در حیاط داخلی است، نه در ورودی اصلی رو به خیابان.',
      'از دری که روی آن Aurora 7 نوشته شده استفاده کنید و سپس تابلوهای آبی را تا پذیرش در طبقه دوم دنبال کنید.']],
    ['ar-04', 'ar', ['مدخل الاستوديو في الفناء الداخلي، وليس عند المدخل الرئيسي المطل على الشارع.',
      'يجب استخدام البوابة المكتوب عليها Aurora 7 ثم اتباع اللافتات الزرقاء إلى الاستقبال في الطابق الثاني.']],
  ] as const) {
    const answer: AnswerOutput = { language, draft: '', obligations: [{ id: 'a1', description: 'x', status: 'answered' }],
      units: [unit('e1', texts[0], 'descriptive', ['ENTRANCE_COURTYARD']), unit('e2', texts[1], 'required', ['GATE_AURORA'])] };
    const { result } = await run(caseId, { answer, verifier: approvingVerifier(s => [{ id: 'v1', description: 'entrance', kind: 'location',
      availableInSources: true, sourcesConflict: false, status: 'complete', coveredByUnits: s.map(u => u.id), missingInformation: [] }]) });
    assert.equal(result.publication, 'complete_draft', `${caseId}: ${JSON.stringify(result.reasons)}`);
    assert.deepEqual([...result.publishedUnitIds], ['e1', 'e2']);
  }
});

test('Persian text in an Arabic reply (and vice versa) is caught deterministically', async () => {
  const answer: AnswerOutput = { language: 'ar', draft: '', obligations: [{ id: 'a1', description: 'x', status: 'answered' }],
    units: [unit('e1', 'ورودی استودیو در حیاط داخلی است، نه در ورودی اصلی رو به خیابان که بیشتر مردم از آن استفاده می‌کنند.', 'descriptive', ['ENTRANCE_COURTYARD'])] };
  const { result } = await run('ar-04', { answer, verifier: approvingVerifier(() => [{ id: 'v1', description: 'x', kind: 'location', availableInSources: true,
    sourcesConflict: false, status: 'not_addressed', coveredByUnits: [], missingInformation: ['entrance'] }]) });
  assert.ok(codes(result).includes('UNIT_LANGUAGE_MISMATCH'));
});

// ---------------- contract, binding and provider failures ----------------
const fatalCases: [string, Script, ReasonCode][] = [
  ['malformed answer JSON', { answer: '{"language":"sv",', verifier: approvingVerifier(sv01Obligations) }, 'ANSWER_MALFORMED'],
  ['answer with an extra field', { answer: JSON.stringify({ ...sv01Answer(), confidence: 0.9 }), verifier: approvingVerifier(sv01Obligations) }, 'ANSWER_MALFORMED'],
  ['answer in the wrong language', { answer: { ...sv01Answer(), language: 'en' }, verifier: approvingVerifier(sv01Obligations) }, 'ANSWER_LANGUAGE_MISMATCH'],
  ['duplicate unit ids', { answer: sv01Answer([...sv01Units(), sv01Units()[0]]), verifier: approvingVerifier(sv01Obligations) }, 'UNIT_DUPLICATE_ID'],
  ['malformed verifier JSON', { answer: sv01Answer(), verifier: () => 'not json' }, 'VERIFIER_MALFORMED'],
  ['verifier with a wrong enum', { answer: sv01Answer(), verifier: (s, d) => JSON.stringify({ ...approvingVerifier(sv01Obligations)(s, d),
    units: approvingVerifier(sv01Obligations)(s, d).units.map(u => ({ ...u, verdict: 'PROBABLY' })) }) }, 'VERIFIER_MALFORMED'],
  ['verifier missing a unit verdict', { answer: sv01Answer(), verifier: (s, d) => { const o = approvingVerifier(sv01Obligations)(s, d); return { ...o, units: o.units.slice(1) }; } }, 'VERIFIER_BINDING_MISMATCH'],
  ['verifier with an unknown unit key', { answer: sv01Answer(), verifier: (s, d) => { const o = approvingVerifier(sv01Obligations)(s, d);
    return { ...o, units: o.units.map((u, i) => i === 0 ? { ...u, unitId: 'U9' } : u) }; } }, 'VERIFIER_BINDING_MISMATCH'],
  ['verifier with a duplicated verdict', { answer: sv01Answer(), verifier: (s, d) => { const o = approvingVerifier(sv01Obligations)(s, d);
    return { ...o, units: [...o.units.slice(0, 3), o.units[0]] }; } }, 'VERIFIER_BINDING_MISMATCH'],
  ['verifier with no obligations', { answer: sv01Answer(), verifier: approvingVerifier(() => []) }, 'VERIFIER_NO_OBLIGATIONS'],
  ['verifier citing an unknown unit', { answer: sv01Answer(), verifier: approvingVerifier(s => [...sv01Obligations(s).slice(0, 2),
    { ...sv01Obligations(s)[2], coveredByUnits: ['u4', 'u9'] }]) }, 'VERIFIER_OBLIGATION_UNIT_UNKNOWN'],
  ['answer provider error', { answer: async () => { throw new Error('500'); }, verifier: approvingVerifier(sv01Obligations) }, 'ANSWER_PROVIDER_ERROR'],
  ['answer truncated', { answer: async () => ({ text: '{', status: 'incomplete' as const, model: 'scripted', requestSha256: '' }), verifier: approvingVerifier(sv01Obligations) }, 'ANSWER_TRUNCATED'],
  ['verifier provider error', { answer: sv01Answer(), verifierRaw: true, verifier: async () => { throw new Error('reset'); } }, 'VERIFIER_PROVIDER_ERROR'],
  ['verifier truncated', { answer: sv01Answer(), verifierRaw: true, verifier: async () => ({ text: '{', status: 'incomplete' as const, model: 'scripted', requestSha256: '' }) }, 'VERIFIER_TRUNCATED'],
];
for (const [name, script, code] of fatalCases) {
  test(`fail closed: ${name} → ${code}`, async () => {
    const { result } = await run('sv-01', script);
    assert.equal(result.publication, 'fallback');
    assert.deepEqual(fatal(result), [code]);
  });
}

test('timeouts abort each call and are reported per stage', async () => {
  const hang = (request: ProviderRequest) => new Promise<never>((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const a = await run('sv-01', { answer: hang as any, verifier: approvingVerifier(sv01Obligations) }, { timeouts: { answerMs: 30, verifierMs: 30 } });
  assert.deepEqual(fatal(a.result), ['ANSWER_PROVIDER_TIMEOUT']);
  assert.equal(a.result.metrics.stages[0].outcome, 'timeout');
  const v = await run('sv-01', { answer: sv01Answer(), verifierRaw: true, verifier: hang as any }, { timeouts: { answerMs: 1000, verifierMs: 30 } });
  assert.deepEqual(fatal(v.result), ['VERIFIER_PROVIDER_TIMEOUT']);
});

// ---------------- freshness and tenant isolation ----------------
test('stale source at publication → STALE_SOURCE; revalidation failure → REVALIDATION_UNAVAILABLE', async () => {
  const stale = await run('sv-01', { answer: sv01Answer(), verifier: approvingVerifier(sv01Obligations) },
    { revalidate: async (_b, ids) => new Map(ids.map(id => [id, id === dataset.sources.KL ? 'r_changed' : rev[id]])) });
  assert.deepEqual(fatal(stale.result), ['STALE_SOURCE']);
  assert.equal(stale.result.reasons[stale.result.reasons.length - 1].sourceId, dataset.sources.KL);
  const down = await run('sv-01', { answer: sv01Answer(), verifier: approvingVerifier(sv01Obligations) }, { revalidate: async () => { throw new Error('db'); } });
  assert.deepEqual(fatal(down.result), ['REVALIDATION_UNAVAILABLE']);
});

test('a source from another tenant refuses the whole turn before any model call', async () => {
  const foreign = [...sources, { ...sources[0], id: 'aaaaaaaa-0000-0000-0000-000000000001', businessId: 4, content: 'Annan kunds data.' }];
  const { result, calls } = await run('sv-01', { answer: sv01Answer(), verifier: approvingVerifier(sv01Obligations) }, { sources: foreign });
  assert.equal(calls.length, 0);
  assert.deepEqual(fatal(result), ['TENANT_SOURCE_MISMATCH']);
});

test('non-ready and duplicate sources refuse the turn; empty corpus refuses the turn', async () => {
  const notReady = await run('sv-01', { answer: sv01Answer(), verifier: approvingVerifier(sv01Obligations) }, { sources: [{ ...sources[0], status: 'processing' }] });
  assert.deepEqual(fatal(notReady.result), ['SOURCE_NOT_READY']);
  const dup = await run('sv-01', { answer: sv01Answer(), verifier: approvingVerifier(sv01Obligations) }, { sources: [sources[0], sources[0]] });
  assert.deepEqual(fatal(dup.result), ['SOURCE_DUPLICATE_ID']);
  const none = await run('sv-01', { answer: sv01Answer(), verifier: approvingVerifier(sv01Obligations) }, { sources: [] });
  assert.deepEqual(fatal(none.result), ['NO_SOURCES']);
});

test('model inputs contain only the pinned tenant corpus as numbered passages, marked as untrusted data; no source ids or revisions', async () => {
  const { calls } = await run('sv-01', { answer: sv01Answer(), verifier: approvingVerifier(sv01Obligations) });
  const answerCall = calls.find(c => c.role === 'answer')!;
  for (const c of calls) {
    for (const s of sources) { assert.ok(!c.input.includes(s.id), `${c.role} input shows a source id`); assert.ok(!c.input.includes(rev[s.id]), `${c.role} input shows a revision`); }
    assert.ok(c.instructions.includes('untrusted data'));
    assert.equal(c.maxOutputTokens, 2048);
  }
  const passages = renderedPassages(answerCall).flat();
  assert.ok(passages.length > 0);
  assert.deepEqual(passages.map(p => p.ref), passages.map((_, i) => `E${i + 1}`), 'references are dense and software-assigned');
  assert.equal(renderedPassages(answerCall).length, sources.length, 'one block per pinned source of this tenant');
});

test('invalid input is refused without model calls', async () => {
  const calls: ProviderRequest[] = [];
  const r = await runReferenceAnswer({ businessId: 3, question: '   ', language: 'sv', history: [], sources },
    { provider: scriptedProvider({ answer: sv01Answer(), verifier: approvingVerifier(sv01Obligations) }, calls), revalidate: currentRevalidation(sources), timeouts: { answerMs: 100, verifierMs: 100 } });
  assert.deepEqual(fatal(r), ['INPUT_INVALID']);
  assert.equal(calls.length, 0);
});

// ---------------- owner policy 2026-11-24: conflicts ----------------
const CONFLICT_SOURCE: SourceRecord = { id: 'c0ffee00-0000-4000-8000-000000000001', businessId: 3, title: 'Syntetisk motstridig källa (test)', type: 'text',
  status: 'ready', updatedAt: '2026-11-24T00:00:00Z',
  content: 'Kunder som besöker studion för första gången måste komma 20 minuter före sin bokade tid. Studions entré ligger vid huvudingången mot gatan.' };
const withConflict = [...sources, CONFLICT_SOURCE];
const conflictRevalidate = currentRevalidation(withConflict);
const ARRIVE_20 = { sourceId: CONFLICT_SOURCE.id, quote: 'Kunder som besöker studion för första gången måste komma 20 minuter före sin bokade tid.' };
const ENTRANCE_STREET = { sourceId: CONFLICT_SOURCE.id, quote: 'Studions entré ligger vid huvudingången mot gatan.' };
const q = (fact: string) => ({ sourceId: dataset.facts[fact].sourceId, quote: dataset.facts[fact].quote });
const conflictVerifier = (conflicts: Record<string, { sourceId: string; quote: string }[]>, notIndependent: string[] = []) =>
  (sent: any, dHash: string) => {
    const out = approvingVerifier(sv01Obligations)(sent, dHash);
    return { ...out,
      obligations: out.obligations.map(o => conflicts[o.id] ? { ...o, sourcesConflict: true, conflictingQuotes: conflicts[o.id] } : o),
      units: out.units.map(u => notIndependent.includes(u.unitId) ? { ...u, independentOfConflicts: false } : u) };
  };

test('proven conflict: conflicting claims withheld, independent entrance information published with the localized notice', async () => {
  const { result } = await run('sv-01', { answer: sv01Answer(), verifier: conflictVerifier({ v1: [q('ARRIVE_10'), ARRIVE_20], v3: [q('ARRIVE_NOT_MANDATORY'), ARRIVE_20] }) },
    { sources: withConflict, revalidate: conflictRevalidate });
  assert.equal(result.publication, 'partial_units', JSON.stringify(result.reasons));
  assert.deepEqual([...result.publishedUnitIds], ['u2', 'u3']);
  assert.deepEqual([...result.limitationObligationIds], ['v1', 'v3']);
  assert.ok(!/10|20/u.test(result.text.replace('Aurora 7', '')), 'a conflicting arrival claim leaked');
  assert.ok(result.text.endsWith(REMAINING.sv));
  assert.ok(result.reasons.some(x => x.code === 'UNIT_DEPENDS_ON_CONFLICT' && x.unitId === 'u1'));
});

test('independence is not taken on trust: a unit citing a conflicting excerpt is withheld even if the verifier calls it independent', async () => {
  const { result } = await run('sv-01', { answer: sv01Answer(), verifier: conflictVerifier({ v1: [q('ENTRANCE_COURTYARD'), ENTRANCE_STREET] }) },
    { sources: withConflict, revalidate: conflictRevalidate });
  assert.ok(result.reasons.some(x => x.code === 'UNIT_DEPENDS_ON_CONFLICT' && x.unitId === 'u2'));
  assert.ok(!result.publishedUnitIds.includes('u2'));
  assert.ok(!result.text.includes('innergården'));
});

test('a unit the verifier marks as dependent on a conflict is withheld', async () => {
  const { result } = await run('sv-01', { answer: sv01Answer(), verifier: conflictVerifier({ v1: [q('ARRIVE_10'), ARRIVE_20] }, ['u4']) },
    { sources: withConflict, revalidate: conflictRevalidate });
  assert.equal(result.publication, 'partial_units');
  assert.deepEqual([...result.publishedUnitIds], ['u2', 'u3']);
  assert.deepEqual([...result.limitationObligationIds].sort(), ['v1', 'v3']);
});

test('conflict excerpts that are not verbatim cannot establish independence → SOURCE_CONFLICT', async () => {
  const { result } = await run('sv-01', { answer: sv01Answer(), verifier: conflictVerifier({ v1: [q('ARRIVE_10'), { ...ARRIVE_20, quote: 'måste komma en halvtimme innan' }] }) },
    { sources: withConflict, revalidate: conflictRevalidate });
  assert.deepEqual(fatal(result), ['SOURCE_CONFLICT']);
});

test('a unit marked dependent while no conflict is reported → VERIFIER_CONFLICT_INCONSISTENT', async () => {
  const { result } = await run('sv-01', { answer: sv01Answer(), verifier: conflictVerifier({}, ['u2']) });
  assert.deepEqual(fatal(result), ['VERIFIER_CONFLICT_INCONSISTENT']);
});

test('every obligation conflicted → natural "no confirmed information" copy, nothing asserted', async () => {
  const all = { v1: [q('ARRIVE_10'), ARRIVE_20], v2: [q('ENTRANCE_COURTYARD'), ENTRANCE_STREET], v3: [q('ARRIVE_NOT_MANDATORY'), ARRIVE_20] };
  const { result } = await run('sv-01', { answer: sv01Answer(), verifier: conflictVerifier(all) }, { sources: withConflict, revalidate: conflictRevalidate });
  assert.equal(result.publication, 'not_in_sources');
  assert.equal(result.text, NOT_IN_SOURCES.sv);
});

// ---------------- owner policy 2026-11-24: internal test code ----------------
const SECRET = 'BLÅ-RÄV-742';
test('the internal test code is redacted from BOTH model inputs (deterministic, not prompt-based)', async () => {
  const answer: AnswerOutput = { language: 'sv', units: [], draft: '', obligations: [{ id: 'a1', description: 'kod', status: 'not_in_sources' }] };
  const calls: ProviderRequest[] = [];
  const result = await runReferenceAnswer({ businessId: 3, question: 'Vad är den hemliga testkoden för företaget?', language: 'sv', history: [], sources },
    { provider: scriptedProvider({ answer, verifier: approvingVerifier(() => [{ id: 'v1', description: 'code', kind: 'information', availableInSources: false,
      sourcesConflict: false, status: 'not_addressed', coveredByUnits: [], missingInformation: [] }]) }, calls),
      revalidate: currentRevalidation(sources), timeouts: { answerMs: 1000, verifierMs: 1000 } });
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.ok(!c.input.includes('742') && !c.input.includes('BLÅ-RÄV'), `${c.role} input contains the code`);
    assert.ok(!c.input.includes('[redacted internal information]'), 'a redacted passage is withheld entirely');
    assert.ok(renderedPassages(c).flat().every(p => !/redacted/iu.test(p.text)), 'a redacted passage gets no evidence reference');
  }
  assert.equal(result.publication, 'not_in_sources');
});

for (const leak of [SECRET, 'bla rav 742', 'BLA-RAV-742', 'Blå Räv 742']) {
  test(`a unit disclosing the code (${leak}) is removed deterministically even if the verifier approves it`, async () => {
    const answer: AnswerOutput = { language: 'sv', draft: `Koden är ${leak}.`, obligations: [{ id: 'a1', description: 'kod', status: 'answered' }],
      units: [{ id: 's1', text: `Testkoden är ${leak}.`, modality: 'descriptive', conditions: [], addresses: [],
        citations: [{ sourceId: dataset.sources.TXT, revision: rev[dataset.sources.TXT], quote: `Den hemliga testkoden för detta företag är ${SECRET}.` }] }] };
    const { result } = await run('sv-07', { answer, verifier: approvingVerifier(s => [{ id: 'v1', description: 'code', kind: 'information',
      availableInSources: false, sourcesConflict: false, status: 'not_addressed', coveredByUnits: s.map(u => u.id), missingInformation: [] }]) });
    assert.ok(result.reasons.some(x => x.code === 'SECRET_IN_UNIT' && x.unitId === 's1'));
    assert.ok(!/742/u.test(result.text));
  });
}

test('an owner-declared protected term is enforced the same way', async () => {
  const c = caseById('sv-04');
  const answer: AnswerOutput = { language: 'sv', draft: '', obligations: [{ id: 'a1', description: 'entré', status: 'answered' }],
    units: [unit('e1', 'Entrén ligger på innergården, inte vid huvudingången mot gatan.', 'descriptive', ['ENTRANCE_COURTYARD'])] };
  const r = await runReferenceAnswer({ businessId: 3, question: c.question, language: 'sv', history: [], sources, protectedTerms: ['innergården'] },
    { provider: scriptedProvider({ answer, verifier: approvingVerifier(s => [{ id: 'v1', description: 'x', kind: 'location', availableInSources: true,
      sourcesConflict: false, status: 'complete', coveredByUnits: s.map(u => u.id), missingInformation: [] }]) }),
      revalidate: currentRevalidation(sources), timeouts: { answerMs: 1000, verifierMs: 1000 } });
  assert.ok(r.reasons.some(x => x.code === 'SECRET_IN_UNIT'));
  assert.equal(r.publication, 'fallback');
});

// ---------------- owner policy 2026-11-24: address ----------------
test('sv-10 address: "sent with the booking confirmation" is a complete, grounded answer', async () => {
  const answer: AnswerOutput = { language: 'sv', draft: 'Besöksadressen får du i samband med bokningsbekräftelsen.',
    obligations: [{ id: 'a1', description: 'adress', status: 'answered' }],
    units: [unit('a1u', 'Besöksadressen meddelas i samband med bokningsbekräftelsen.', 'descriptive', ['TXT_ADDRESS'])] };
  const { result } = await run('sv-10', { answer, verifier: approvingVerifier(s => [{ id: 'v1', description: 'address', kind: 'location',
    availableInSources: true, sourcesConflict: false, status: 'complete', coveredByUnits: s.map(u => u.id), missingInformation: [] }]) });
  assert.equal(result.publication, 'complete_draft');
});

test('an invented street address cannot pass the deterministic checks', async () => {
  const answer: AnswerOutput = { language: 'sv', draft: '', obligations: [{ id: 'a1', description: 'adress', status: 'answered' }],
    units: [unit('a1u', 'Adressen är Stjärngatan 12 och den meddelas i samband med bokningsbekräftelsen.', 'descriptive', ['TXT_ADDRESS'])] };
  const { result } = await run('sv-10', { answer, verifier: approvingVerifier(() => [{ id: 'v1', description: 'address', kind: 'location',
    availableInSources: true, sourcesConflict: false, status: 'not_addressed', coveredByUnits: [], missingInformation: ['address via confirmation'] }]) });
  assert.ok(codes(result).includes('NUMBER_NOT_IN_CITATION'));
  assert.equal(result.publication, 'fallback');
});

// =====================================================================================================================
// Pilot root cause (2026-11-24). The genuine unit texts were NOT saved; every unit text below is a SYNTHETIC reproduction
// of the observed trace shape (unit u2, modality "descriptive", answering the requirement obligation from the Knowledge
// Library sentence). They are not presented as observed model output.
// =====================================================================================================================
const NOT_MANDATORY: Record<Language, string> = {
  sv: 'Det är en rekommendation för förstagångsbesökare, inte ett obligatoriskt krav eller en sista ankomsttid.',
  en: 'This is a recommendation for first-time visitors, not a mandatory requirement or a latest arrival time.',
  de: 'Das ist eine Empfehlung für Erstbesucher, keine Pflicht und keine späteste Ankunftszeit.',
  es: 'No hace falta llegar antes: es solo una recomendación para quienes vienen por primera vez, no una hora límite.',
  fa: 'این فقط یک توصیه برای مراجعه‌کنندگان بار اول است، نه یک الزام و نه آخرین زمان ورود.',
  ar: 'هذه مجرد توصية للزوار لأول مرة، وليست شرطًا ولا آخر موعد للوصول.',
};
const ctx = () => pinCorpus(3, sources).corpus!;

test('SYNTHETIC root-cause reproduction: a "not mandatory" unit citing the Knowledge Library sentence passes the objective checks in all six languages, with either modality label', () => {
  for (const [language, text] of Object.entries(NOT_MANDATORY) as [Language, string][])
    for (const modality of ['descriptive', 'not_required'] as const)
      assert.equal(checkUnit(unit('u2', text, modality, ['ARRIVE_NOT_MANDATORY']), ctx(), language), undefined, `${language}/${modality}`);
});

test('SYNTHETIC sv-01 trace shape (u2 descriptive = requirement answer) now publishes; previously fell back with AVAILABLE_SOURCE_FACT_OMITTED', async () => {
  const units = [...sv01Units()];
  units[3] = unit('u4', NOT_MANDATORY.sv, 'descriptive', ['ARRIVE_NOT_MANDATORY']);
  const { result } = await run('sv-01', { answer: sv01Answer(units), verifier: approvingVerifier(sv01Obligations) });
  assert.equal(result.publication, 'complete_draft', JSON.stringify(result.reasons));
});

test('recommendation vs requirement is the verifier\'s binding verdict: "required" for a recommendation is rejected (VERIFIER_MODALITY_WRONG) and the turn fails closed', async () => {
  const units = sv01Units();
  units[0] = { ...units[0], modality: 'required', text: 'Vid ditt första besök måste du komma cirka 10 minuter före din bokade tid.' };
  assert.equal(checkUnit(units[0], ctx(), 'sv'), undefined, 'objective checks pass: the number and quote are genuine');
  const verifier = (sent: any, d: string) => { const o = approvingVerifier(sv01Obligations)(sent, d);
    return { ...o, units: o.units.map(u => u.unitId === 'u1' ? { ...u, modalityCorrect: false, verdict: 'CONTRADICTED' as const } : u) }; };
  const { result } = await run('sv-01', { answer: sv01Answer(units), verifier });
  assert.ok(result.reasons.some(r => r.code === 'VERIFIER_CONTRADICTED' && r.unitId === 'u1'));
  assertRecovery(result, ['OBLIGATION_INCOMPLETE'], ['u1'], sv01Answer(units));
  assert.ok(!result.text.includes('måste'));
  assert.ok(VERIFIER_INSTRUCTIONS.includes('recommendation vs requirement'));
});

test('negation in all six languages: a polarity-flipped unit ("it is mandatory") is rejected by the verifier verdict, a faithful one is published', async () => {
  for (const language of ['sv', 'en', 'de', 'es', 'fa', 'ar'] as const) {
    const id = `${language}-03`;
    const answer: AnswerOutput = { language, draft: '', obligations: [{ id: 'a1', description: 'x', status: 'answered' }],
      units: [unit('n1', NOT_MANDATORY[language], 'not_required', ['ARRIVE_NOT_MANDATORY'])] };
    const ob = (s: readonly { id: string }[]) => [{ id: 'v1', description: 'requirement', kind: 'requirement' as const, availableInSources: true,
      sourcesConflict: false, status: 'complete' as const, coveredByUnits: s.map(u => u.id), missingInformation: [] }];
    const ok = await run(id, { answer, verifier: approvingVerifier(ob) });
    assert.equal(ok.result.publication, 'complete_draft', `${language}: ${JSON.stringify(ok.result.reasons)}`);
    const flipped = (s: any, d: string) => { const o = approvingVerifier(ob)(s, d); return { ...o, units: o.units.map(u => ({ ...u, verdict: 'CONTRADICTED' as const })) }; };
    const bad = await run(id, { answer, verifier: flipped });
    assert.equal(bad.result.publication, 'fallback', language);
    assert.ok(bad.result.reasons.some(r => r.code === 'VERIFIER_CONTRADICTED'));
  }
});

test('customer-supplied numbers are not source claims: sv-08 "20 minutes" is allowed, an invented number is not', async () => {
  const c = caseById('sv-08');
  const corpus = ctx();
  const customer = customerSuppliedNumbers(c.question, c.history, 'sv');
  assert.ok(customer.has(20));
  const hypothetical = unit('l1', 'Om du blir 20 minuter sen, alltså mer än 15 minuter, kan studion behöva göra en ny bedömning av om besöket kan genomföras enligt plan.', 'descriptive', ['LATE_15']);
  assert.equal(checkUnit(hypothetical, corpus, 'sv', customer), undefined);
  assert.deepEqual(checkUnit(hypothetical, corpus, 'sv'), { code: 'NUMBER_NOT_IN_CITATION', detail: 'number:20' }, 'without the customer context the old rejection reproduces');
  const invented = unit('l2', 'Vid en försening på mer än 25 minuter kan studion behöva göra en ny bedömning.', 'descriptive', ['LATE_15']);
  assert.deepEqual(checkUnit(invented, corpus, 'sv', customer), { code: 'NUMBER_NOT_IN_CITATION', detail: 'number:25' });
  // Only customer turns count: a number from an assistant turn is not customer-supplied.
  assert.ok(!customerSuppliedNumbers('Och sedan?', [{ role: 'assistant', content: 'Det tar 30 minuter.' }], 'sv').has(30));
  assert.ok(customerSuppliedNumbers('Och sedan?', [{ role: 'user', content: 'Jag blir 30 minuter sen.' }], 'sv').has(30));
});

test('incorrect numerical claims are still rejected with an exact detail', () => {
  const wrong = unit('u1', 'Om det är ditt första besök rekommenderas du att komma cirka 15 minuter före din bokade tid.', 'recommended', ['ARRIVE_10']);
  assert.deepEqual(checkUnit(wrong, ctx(), 'sv', customerSuppliedNumbers(caseById('sv-01').question, [], 'sv')), { code: 'NUMBER_NOT_IN_CITATION', detail: 'number:15' });
});

test('SYNTHETIC sv-08 trace shape: "not in sources" + "missing facts" is reported as VERIFIER_OBLIGATION_INCONSISTENT on the right obligation, and every failing obligation is reported', async () => {
  const answer: AnswerOutput = { language: 'sv', draft: '', obligations: [{ id: 'o1', description: 'öppettider', status: 'not_in_sources' }, { id: 'o2', description: 'sen', status: 'answered' }],
    units: [unit('u2', 'Om du riskerar att bli sen bör du kontakta studion så snart som möjligt via den kanal där du brukar kommunicera med dem.', 'recommended', ['LATE_CONTACT'])] };
  const verifier = approvingVerifier(s => [
    { id: 'o1', description: 'hours', kind: 'information', availableInSources: false, sourcesConflict: false, status: 'not_addressed', coveredByUnits: [], missingInformation: ['hours are not stated'] },
    { id: 'o2', description: 'late', kind: 'information', availableInSources: true, sourcesConflict: false, status: 'incomplete', coveredByUnits: s.map(u => u.id), missingInformation: ['reassessment above 15 minutes'] },
  ]);
  const { result } = await run('sv-08', { answer, verifier });
  assert.deepEqual(result.reasons.filter(r => r.fatal).map(r => [r.code, r.obligationId]),
    [['VERIFIER_OBLIGATION_INCONSISTENT', 'o1'], ['AVAILABLE_SOURCE_FACT_OMITTED', 'o2']]);
  for (const r of result.reasons.filter(r => r.obligationId)) assert.ok(result.trace.verifierObligations.some(o => o.id === r.obligationId), 'reason bound to a verifier obligation id');
});

test('SYNTHETIC fa-08 trace shape is preserved: four approved units (recommended, recommended, required, permitted) → complete_draft', async () => {
  const units = [
    unit('u1', 'برای اولین مراجعه توصیه می‌شود حدود ۱۰ دقیقه قبل از وقت رزرو برسید؛ این توصیه است، نه الزام.', 'recommended', ['ARRIVE_10']),
    unit('u2', 'بهتر است تأییدیه رزرو خود را به صورت دیجیتال یا کاغذی همراه داشته باشید؛ این کار اختیاری است.', 'recommended', ['CONFIRMATION_OPTIONAL']),
    unit('u3', 'اگر دستورالعمل آمادگی خاصی دریافت کرده‌اید، باید آن را رعایت کنید.', 'required', ['SPECIAL_INSTRUCTIONS']),
    unit('u4', 'همراه داشتن بطری آب شخصی مجاز است.', 'permitted', ['WATER']),
  ];
  const draft = units.map(u => u.text).join(' ');
  const answer: AnswerOutput = { language: 'fa', units, draft, obligations: [{ id: 'o1', description: 'زمان', status: 'answered' }, { id: 'o2', description: 'همراه', status: 'answered' }] };
  const { result } = await run('fa-08', { answer, verifier: approvingVerifier(() => [
    { id: 'o1', description: 'arrival', kind: 'recommendation', availableInSources: true, sourcesConflict: false, status: 'complete', coveredByUnits: ['u1'], missingInformation: [] },
    { id: 'o2', description: 'bring', kind: 'requirement', availableInSources: true, sourcesConflict: false, status: 'complete', coveredByUnits: ['u2', 'u3', 'u4'], missingInformation: [] },
  ]) });
  assert.equal(result.publication, 'complete_draft', JSON.stringify(result.reasons));
});

test('diagnostic evidence: captured only when asked, includes answer, units, citations, draft, rejection details and verifier verdicts, and is secret-redacted', async () => {
  const units = [...sv01Units(), { id: 'u9', text: 'Koden är BLÅ-RÄV-742.', modality: 'descriptive' as const, conditions: [], addresses: [],
    citations: [{ sourceId: dataset.sources.TXT, revision: rev[dataset.sources.TXT], quote: 'Den hemliga testkoden för detta företag är BLÅ-RÄV-742.' }] }];
  units[0] = { ...units[0], text: units[0].text.replace('cirka 10', 'cirka 25') };
  const calls: ProviderRequest[] = [];
  const c = caseById('sv-01');
  const opts = (capture: boolean) => ({ provider: scriptedProvider({ answer: sv01Answer(units), verifier: approvingVerifier(sv01Obligations) }, calls),
    revalidate: currentRevalidation(sources), timeouts: { answerMs: 1000, verifierMs: 1000 }, ...(capture ? { captureEvidence: true } : {}) });
  const input = { businessId: 3, question: c.question, language: 'sv' as const, history: [], sources };
  assert.equal((await runReferenceAnswer(input, opts(false))).evidence, undefined);
  const r = await runReferenceAnswer(input, opts(true));
  const e = r.evidence!;
  assert.equal(e.answer!.units.length, 5);
  assert.equal(e.answer!.draft, REDACTION, 'the assembled authored reply contained the secret segment and is redacted whole');
  assert.ok(e.answer!.units[0].citations[0].quote.length > 15);
  assert.deepEqual(e.deterministic, [{ unitId: 'u1', code: 'NUMBER_NOT_IN_CITATION', detail: 'number:25' }, { unitId: 'u9', code: 'SECRET_IN_UNIT' }]);
  assert.ok(e.verifier!.obligations.length === 3 && e.verifier!.units.length === 3);
  assert.ok(!JSON.stringify(e).includes('742'), 'protected code in evidence');
});

// ---------------- verified partial recovery and natural partial drafts (SYNTHETIC adversarial responses) ----------------
test('recovery notice never claims absence: it differs from the "not in sources" copy in every language', () => {
  for (const l of ['sv', 'en', 'de', 'es', 'fa', 'ar'] as const) {
    assert.notEqual(VERIFICATION_REMAINING[l], REMAINING[l]);
    assert.notEqual(VERIFICATION_REMAINING[l], NOT_IN_SOURCES[l]);
  }
});

test('recovery never publishes the authored reply verbatim', async () => {
  const verifier = (sent: any, d: string) => { const o = approvingVerifier(sv01Obligations)(sent, d);
    return { ...o, units: o.units.map(u => u.unitId === 'u4' ? { ...u, verdict: 'NOT_ENTAILED' as const } : u) }; };
  const { result } = await run('sv-01', { answer: sv01Answer(), verifier });
  assert.equal(result.publication, 'partial_verified_recovery');
  assert.notEqual(result.text, sv01Units().map(u => u.text).join(' '));
  assert.ok(!result.text.includes(sv01Units()[3].text));
});

test('recovery with both a genuinely absent and an unverified obligation uses the verification notice and lists both', async () => {
  const units = [
    unit('l1', 'Vid en försening på mer än 15 minuter kan studion behöva göra en ny bedömning av om besöket kan genomföras enligt plan.', 'descriptive', ['LATE_15']),
    unit('l2', 'Om du riskerar att bli sen bör du kontakta studion så snart som möjligt via den kanal där du brukar kommunicera med dem.', 'recommended', ['LATE_CONTACT']),
  ];
  const answer: AnswerOutput = { language: 'sv', units, draft: '', obligations: [{ id: 'a1', description: 'x', status: 'answered' }] };
  const verifier = (sent: any, d: string) => { const o = approvingVerifier(() => [
    { id: 'h', description: 'hours', kind: 'information', availableInSources: false, sourcesConflict: false, status: 'not_addressed', coveredByUnits: [], missingInformation: [] },
    { id: 'late', description: 'late', kind: 'information', availableInSources: true, sourcesConflict: false, status: 'complete', coveredByUnits: ['l2'], missingInformation: [] },
    { id: 'cancel', description: 'cancelled?', kind: 'information', availableInSources: true, sourcesConflict: false, status: 'incomplete', coveredByUnits: ['l1'], missingInformation: ['not automatically cancelled'] },
  ])(sent, d); return o; };
  const { result } = await run('sv-08', { answer, verifier });
  assert.equal(result.publication, 'partial_verified_recovery');
  assert.deepEqual([...result.publishedUnitIds], ['l2']);
  assert.deepEqual([...result.limitationObligationIds].sort(), ['cancel', 'h']);
  assert.ok(result.text.endsWith(VERIFICATION_REMAINING.sv));
});

const HOURS_LIMIT = 'Öppettiderna har jag tyvärr ingen information om.';
const limitation = (id: string, text: string, addresses = ['a0']): AnswerUnit =>
  ({ id, kind: 'limitation', text, modality: 'descriptive', conditions: [], citations: [], evidence: [], addresses });
const partialAnswer = (lim: AnswerUnit): AnswerOutput => ({ language: 'sv', draft: '', units: [lim,
  unit('l1', 'Vid en försening på mer än 15 minuter kan studion behöva göra en ny bedömning av om besöket kan genomföras enligt plan.', 'descriptive', ['LATE_15'])],
  obligations: [{ id: 'a0', description: 'hours', status: 'not_in_sources' }, { id: 'a1', description: 'x', status: 'answered' }] });
const partialObligations = (availableHours: boolean, hoursStatus: 'not_addressed' | 'incomplete' = 'not_addressed') => (s: readonly { id: string }[]) => [
  { id: 'h', description: 'hours', kind: 'information' as const, availableInSources: availableHours, sourcesConflict: false, status: hoursStatus,
    coveredByUnits: s.filter(u => u.id.startsWith('h')).map(u => u.id), missingInformation: [] },
  { id: 'late', description: 'late', kind: 'information' as const, availableInSources: true, sourcesConflict: false, status: 'complete' as const, coveredByUnits: ['l1'], missingInformation: [] },
];
test('natural partial answer: a verified limitation segment names the missing subject and the authored reply is published verbatim', async () => {
  const answer = partialAnswer(limitation('h1', HOURS_LIMIT));
  const { result } = await run('sv-08', { answer, verifier: approvingVerifier(partialObligations(false)) });
  assert.equal(result.publication, 'partial_draft', JSON.stringify(result.reasons));
  assert.equal(result.text, `${HOURS_LIMIT} ${answer.units[1].text}`);
  assert.ok(!result.text.includes(REMAINING.sv), 'no generic copy when the limitation is stated naturally');
  assert.deepEqual([...result.limitationObligationIds], ['h']);
});
test('limitations are never taken on trust: unverified, numeric, evidenced, mis-addressed or available-in-sources limitations are dropped and fixed copy closes the gap', async () => {
  const notEntailed = (sent: any, d: string) => { const o = approvingVerifier(partialObligations(false))(sent, d);
    return { ...o, units: o.units.map(u => u.unitId === 'h1' ? { ...u, verdict: 'NOT_ENTAILED' as const } : u) }; };
  const cases: [string, AnswerUnit, any, string][] = [
    ['verifier rejects it', limitation('h1', HOURS_LIMIT), notEntailed, 'VERIFIER_NOT_ENTAILED'],
    ['it states a number', limitation('h1', 'Vi har öppet till 18 på vardagar.'), approvingVerifier(partialObligations(false)), 'LIMITATION_INVALID'],
    ['it carries evidence', { ...limitation('h1', HOURS_LIMIT), evidence: ['E6'] }, approvingVerifier(partialObligations(false)), 'LIMITATION_INVALID'],
    ['it addresses an answered obligation', limitation('h1', HOURS_LIMIT, ['a1']), approvingVerifier(partialObligations(false)), 'LIMITATION_INVALID'],
    ['the verifier finds the subject IN the sources', limitation('h1', HOURS_LIMIT), approvingVerifier(partialObligations(true, 'incomplete')), 'LIMITATION_NOT_VERIFIED_ABSENT'],
  ];
  for (const [name, lim, verifier, code] of cases) {
    const { result } = await run('sv-08', { answer: partialAnswer(lim), verifier });
    assert.ok(result.reasons.some(r => r.code === code && r.unitId === 'h1'), `${name}: expected ${code}, got ${codes(result)}`);
    assert.equal(result.publication, 'partial_units', name);
    assert.ok(!result.text.includes(lim.text), `${name}: limitation published`);
    assert.ok(result.text.endsWith(REMAINING.sv), `${name}: no fixed copy`);
  }
});
test('nothing asked is in the sources: verified limitation segments are the reply (not_in_sources, natural); otherwise fixed copy', async () => {
  const answer: AnswerOutput = { language: 'sv', draft: '', units: [limitation('h1', HOURS_LIMIT)], obligations: [{ id: 'a0', description: 'hours', status: 'not_in_sources' }] };
  const ob = (s: readonly { id: string }[]) => [{ id: 'h', description: 'hours', kind: 'information' as const, availableInSources: false, sourcesConflict: false,
    status: 'not_addressed' as const, coveredByUnits: s.map(u => u.id), missingInformation: [] }];
  const natural = await run('sv-08', { answer, verifier: approvingVerifier(ob) });
  assert.equal(natural.result.publication, 'not_in_sources');
  assert.equal(natural.result.text, HOURS_LIMIT);
  const rejected = await run('sv-08', { answer, verifier: (sent: any, d: string) => { const o = approvingVerifier(ob)(sent, d);
    return { ...o, units: o.units.map(u => ({ ...u, verdict: 'NOT_ENTAILED' as const })) }; } });
  assert.equal(rejected.result.publication, 'not_in_sources');
  assert.equal(rejected.result.text, NOT_IN_SOURCES.sv);
});
test('paragraph structure and authored order survive omission of a segment (no reordering, no rewriting)', async () => {
  const units = sv01Units().map((u, i) => ({ ...u, newParagraph: i === 2 }));
  const verifier = (sent: any, d: string) => { const o = approvingVerifier(sv01Obligations)(sent, d);
    return { ...o, units: o.units.map(u => u.unitId === 'u4' ? { ...u, verdict: 'NOT_ENTAILED' as const } : u) }; };
  const full = await run('sv-01', { answer: sv01Answer(units), verifier: approvingVerifier(sv01Obligations) });
  assert.equal(full.result.text, `${units[0].text} ${units[1].text}\n\n${units[2].text} ${units[3].text}`);
  const partial = await run('sv-01', { answer: sv01Answer(units), verifier });
  assert.equal(partial.result.publication, 'partial_verified_recovery');
  assert.equal(partial.result.text, `${units[0].text} ${units[1].text}\n\n${units[2].text}\n\n${VERIFICATION_REMAINING.sv}`);
});

// ---------------- prompt-cache friendly request layout (Optimization Phase 2) ----------------
test('both calls put the static tenant sources before turn-specific content: the instructions + sources prefix is identical across turns', async () => {
  const a = await run('sv-01', { answer: sv01Answer(), verifier: approvingVerifier(sv01Obligations) });
  const b = await run('en-06', { answer: { language: 'en', draft: '', obligations: [{ id: 'a1', description: 'x', status: 'not_in_sources' }], units: [] },
    verifier: approvingVerifier(() => [{ id: 'v1', description: 'x', kind: 'information', availableInSources: false, sourcesConflict: false, status: 'not_addressed',
      coveredByUnits: [], missingInformation: [] }]) });
  for (const role of ['answer', 'verifier'] as const) {
    const x = a.calls.find(c => c.role === role)!, y = b.calls.find(c => c.role === role)!;
    assert.equal(x.instructions, y.instructions);
    const end = x.input.lastIndexOf('</source>') + '</source>'.length;
    assert.ok(end > 1000 && x.input.slice(0, end) === y.input.slice(0, end), `${role}: the sources prefix differs between turns`);
    assert.ok(x.input.indexOf(caseById('sv-01').question) > end, `${role}: the question precedes the sources`);
  }
});

// Genuine Stage B (es-conv-t1): an ordinal word used adverbially must not be read as the quantity 1; quantities stay strict.
test('number check: adverbial ordinal words are not quantities; digits and cardinal words are still verified', () => {
  const src = loadFixtureSources();
  const corpus = pinCorpus(3, src).corpus!;
  const passage = corpus.sources.flatMap(s => [s]).find(s => s.modelContent.includes('Kunden behöver beskriva föremålet'))!;
  const quote = 'Kunden behöver beskriva föremålet innan det kan lämnas ut.';
  const unit = (text: string) => ({ id: 'u', text, modality: 'required' as const, conditions: [], citations: [{ sourceId: passage.id, revision: passage.revision, quote }], addresses: ['a1'] });
  assert.equal(checkUnit(unit('Para poder entregarte el paraguas, necesitamos que lo describas primero.') as any, corpus, 'es'), undefined);
  assert.equal(checkUnit(unit('You need to describe the item first before we can hand it over.') as any, corpus, 'en'), undefined);
  assert.deepEqual(checkUnit(unit('Necesitamos que lo describas en 3 frases.') as any, corpus, 'es'), { code: 'NUMBER_NOT_IN_CITATION', detail: 'number:3' });
  assert.deepEqual(checkUnit(unit('Necesitamos que lo describas en tres frases.') as any, corpus, 'es'), { code: 'NUMBER_NOT_IN_CITATION', detail: 'number:3' });
});
