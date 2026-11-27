/**
 * EXPERIMENTAL — citation protocol v2 (software-owned evidence references): adversarial and regression tests. Offline; zero provider calls.
 * Synthetic: every model output here is scripted. These tests prove software properties, not model behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceMap, evidenceMapMatches, resolveEvidence, splitPassages, EVIDENCE_REF } from './evidence';
import { pinCorpus } from './corpus';
import { buildManifest, manifestIntact, unitHash } from './manifest';
import { parseAnswer } from './contracts';
import { runReferenceAnswer } from './pipeline';
import { normalizeText } from './text-checks';
import { loadDataset, loadFixtureSources } from './eval/dataset';
import { approvingVerifier, currentRevalidation, scriptedProvider, sentUnits } from './eval/scripted';
import type { AnswerOutput, AnswerUnit, ProviderRequest, SourceRecord } from './types';

const dataset = loadDataset();
const sources = loadFixtureSources();
const corpus = () => pinCorpus(3, sources).corpus!;
const passageWith = (needle: string) => corpus().evidence.passages.find(p => p.text.includes(needle))!;

// ---------------- splitting and the map ----------------
test('passages are verbatim, lossless slices of each source: concatenation reproduces the model-visible text', () => {
  // Whitespace-only slices are not passages; every passage is a verbatim substring, in order.
  for (const s of corpus().sources) { let at = 0; for (const p of splitPassages(s.modelContent)) { const i = s.modelContent.indexOf(p, at); assert.ok(i >= at, p); at = i + p.length; } }
  for (const s of corpus().sources) assert.equal(normalizeText(splitPassages(s.modelContent).join('')), normalizeText(s.modelContent));
  const sample = 'Garagets infart ligger på Stjärngatan 14. Från garaget tar det fem minuter.\n2. Hitta till studion\nPorten heter Aurora 7.';
  assert.deepEqual(splitPassages(sample).map(p => p.trim()), ['Garagets infart ligger på Stjärngatan 14.', 'Från garaget tar det fem minuter.',
    '2. Hitta till studion', 'Porten heter Aurora 7.']);
  assert.deepEqual(splitPassages('ابتدا تماس بگیرید؟ سپس بیایید.').map(p => p.trim()), ['ابتدا تماس بگیرید؟', 'سپس بیایید.']);
});

test('every dataset fact quote is an exact run of whole passages of its source (precision is not reduced)', () => {
  const c = corpus();
  for (const [name, f] of Object.entries<any>(dataset.facts)) {
    const own = c.evidence.passages.filter(p => p.sourceId === f.sourceId);
    const q = normalizeText(f.quote);
    const found = own.some((_, a) => own.slice(a).some((__, n) => normalizeText(own.slice(a, a + n + 1).map(p => p.text).join('')) === q));
    assert.ok(found, `${name} is not a whole-passage run`);
  }
});

test('references are software-assigned, dense, unique and well-formed; the map is deep-frozen', () => {
  const m = corpus().evidence;
  assert.deepEqual(m.passages.map(p => p.ref), m.passages.map((_, i) => `E${i + 1}`));
  assert.ok(m.passages.every(p => EVIDENCE_REF.test(p.ref)));
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.passages) && m.passages.every(Object.isFrozen));
  assert.throws(() => { (m.passages[0] as any).text = 'mutated'; });
  assert.throws(() => { (m.passages as any).push({}); });
});

test('valid references resolve to {sourceId, pinned revision, verbatim passage}; duplicates collapse; adjacent passages merge verbatim', () => {
  const c = corpus();
  const p = passageWith('cirka 10 minuter');
  const r = resolveEvidence(c.evidence, [p.ref, p.ref]);
  assert.deepEqual(r.citations, [{ sourceId: p.sourceId, revision: c.byId.get(p.sourceId)!.revision, quote: p.text }]);
  assert.ok(c.byId.get(p.sourceId)!.modelContent.includes(p.text));
  const next = c.evidence.byRef.get(`E${Number(p.ref.slice(1)) + 1}`)!;
  const merged = resolveEvidence(c.evidence, [p.ref, next.ref]).citations!;
  assert.equal(merged.length, 1);
  assert.ok(c.byId.get(p.sourceId)!.modelContent.includes(merged[0].quote), 'a merged citation is still one verbatim slice');
});

test('unknown and malformed references are refused (no partial resolution, no fuzzy matching)', () => {
  const m = corpus().evidence;
  for (const bad of ['E0', 'E01', 'e6', 'E6 ', ' E6', 'U1', '6', 'E', 'E99999', `E${m.passages.length + 1}`, '', 'E6\u200b', '\uff256'])
    assert.equal(resolveEvidence(m, ['E6', bad]).failure?.code, 'EVIDENCE_REF_UNKNOWN', JSON.stringify(bad));
  // The answer schema refuses malformed references outright; the turn would fail closed.
  const wire = (ref: string) => JSON.stringify({ language: 'sv', obligations: [{ id: 'a1', description: 'x', status: 'answered' }],
    reply: [{ id: 'u1', kind: 'claim', text: 't', modality: 'descriptive', conditions: [], addresses: [], evidence: [ref], newParagraph: false }] });
  assert.ok(parseAnswer(wire('E6')));
  for (const bad of ['e6', 'E06', 'U1', 'E6 ', '']) assert.equal(parseAnswer(wire(bad)), undefined, bad);
});

test('cross-tenant and stale maps are refused: a map is bound to one tenant, one set of sources, one revision each', () => {
  const pinned = corpus();
  const foreign = buildEvidenceMap(4, pinned.sources);
  assert.notEqual(foreign.id, pinned.evidence.id);
  assert.equal(evidenceMapMatches(foreign, 3, pinned.sources), false, 'another tenant’s map, same text');
  assert.equal(evidenceMapMatches(pinned.evidence, 3, pinned.sources), true);
  // A source edit produces a new revision; the old map no longer matches and refs resolve to the new revision only.
  const edited: SourceRecord[] = sources.map(s => s.content?.includes('cirka 10 minuter') ? { ...s, content: s.content.replace('cirka 10 minuter', 'cirka 15 minuter') } : s);
  const fresh = pinCorpus(3, edited).corpus!;
  assert.equal(evidenceMapMatches(pinned.evidence, 3, fresh.sources), false, 'stale map accepted');
  const p = fresh.evidence.passages.find(x => x.text.includes('cirka 15 minuter'))!;
  assert.equal(resolveEvidence(fresh.evidence, [p.ref]).citations![0].revision, fresh.byId.get(p.sourceId)!.revision);
  assert.notEqual(fresh.byId.get(p.sourceId)!.revision, pinned.byId.get(p.sourceId)!.revision);
  // A tenant can never resolve into another tenant's sources: resolution is confined to the map's own passages.
  const ids = new Set(pinned.sources.map(s => s.id));
  assert.ok(pinned.evidence.passages.every(x => ids.has(x.sourceId)));
});

test('evidence substitution after manifest creation is detected (manifest id, unit hash and map id all bind the evidence)', () => {
  const c = corpus();
  const a = passageWith('cirka 10 minuter'), b = passageWith('innergården, inte vid');
  const mk = (ref: string): AnswerUnit => ({ id: 'u1', text: 'x', modality: 'descriptive', conditions: [], addresses: [], evidence: [ref],
    citations: resolveEvidence(c.evidence, [ref]).citations! });
  const m1 = buildManifest([mk(a.ref)], 'd', c.evidence.id);
  const m2 = buildManifest([mk(b.ref)], 'd', c.evidence.id);
  assert.notEqual(m1.id, m2.id);
  assert.notEqual(unitHash(mk(a.ref)), unitHash(mk(b.ref)));
  assert.equal(manifestIntact(m1, [mk(a.ref)], 'd', c.evidence.id), true);
  assert.equal(manifestIntact(m1, [mk(b.ref)], 'd', c.evidence.id), false, 'substituted evidence accepted');
  assert.equal(manifestIntact(m1, [mk(a.ref)], 'd', 'e_000000000000000000000000'), false, 'substituted map accepted');
  assert.throws(() => { (m1.entries[0].evidence as any).push('E1'); });
});

// ---------------- through the pipeline (scripted models) ----------------
const ARRIVE = () => passageWith('cirka 10 minuter');
async function runOne(units: Partial<AnswerUnit>[], opts: { draft?: string; verifier?: any; question?: string } = {}) {
  const answer: AnswerOutput = { language: 'sv', draft: opts.draft ?? '', obligations: [{ id: 'a1', description: 'ankomst', status: 'answered' }],
    units: units.map((u, i) => ({ id: `u${i + 1}`, text: '', modality: 'recommended', conditions: [], addresses: [], citations: [], ...u })) as AnswerUnit[] };
  const calls: ProviderRequest[] = [];
  const result = await runReferenceAnswer({ businessId: 3, question: opts.question ?? 'När ska jag komma till mitt första besök?', language: 'sv', history: [], sources },
    { provider: scriptedProvider({ answer, verifier: opts.verifier ?? approvingVerifier(s => [{ id: 'v1', description: 'ankomst', kind: 'information',
      availableInSources: true, sourcesConflict: false, status: 'complete', coveredByUnits: s.map(u => u.id), missingInformation: [] }]) }, calls),
      revalidate: currentRevalidation(sources), timeouts: { answerMs: 2000, verifierMs: 2000 }, captureEvidence: true });
  return { result, calls, answer };
}
const TEXT = 'Vid ditt första besök rekommenderas du att komma cirka 10 minuter före din bokade tid.';

test('a valid reference publishes; software, not the model, supplies source id, revision and passage text', async () => {
  const { result, calls } = await runOne([{ text: TEXT, evidence: [ARRIVE().ref], conditions: ['första besöket'] }], { draft: TEXT });
  assert.equal(result.publication, 'complete_draft', JSON.stringify(result.reasons));
  const c = result.evidence!.answer!.units[0].citations[0];
  assert.equal(c.sourceId, ARRIVE().sourceId);
  assert.equal(c.quote, ARRIVE().text);
  const verifier = calls.find(x => x.role === 'verifier')!;
  const sent = sentUnits(verifier)[0];
  assert.deepEqual(sent.evidence, [ARRIVE().ref]);
  assert.ok(verifier.input.includes(JSON.stringify(normalizeText(ARRIVE().text))), 'the verifier sees the resolved passage text');
});

test('numeric fidelity through resolved passages: Persian digits match, a changed number or a reference without the number is refused', async () => {
  const fa = await runReferenceAnswer({ businessId: 3, question: 'برای اولین مراجعه کی باید برسم؟', language: 'fa', history: [], sources }, {
    provider: scriptedProvider({ answer: { language: 'fa', draft: '', obligations: [{ id: 'a1', description: 'x', status: 'answered' }],
      units: [{ id: 'u1', text: 'برای اولین مراجعه توصیه می‌شود حدود ۱۰ دقیقه زودتر برسید.', modality: 'recommended', conditions: [], addresses: [], citations: [], evidence: [ARRIVE().ref] }] },
      verifier: approvingVerifier(s => [{ id: 'v1', description: 'x', kind: 'information', availableInSources: true, sourcesConflict: false, status: 'complete',
        coveredByUnits: s.map(u => u.id), missingInformation: [] }]) }),
    revalidate: currentRevalidation(sources), timeouts: { answerMs: 2000, verifierMs: 2000 } });
  assert.notEqual(fa.publication, 'fallback', JSON.stringify(fa.reasons));
  const changed = await runOne([{ text: TEXT.replace('10', '15'), evidence: [ARRIVE().ref] }]);
  assert.ok(changed.result.reasons.some(r => r.code === 'NUMBER_NOT_IN_CITATION'));
  const wrongPassage = await runOne([{ text: TEXT, evidence: [passageWith('innergården, inte vid').ref] }]);
  assert.ok(wrongPassage.result.reasons.some(r => r.code === 'NUMBER_NOT_IN_CITATION'));
  assert.ok(!wrongPassage.result.text.includes('10 minuter'));
});

test('incorrect semantic attribution (a number-free claim citing an unrelated passage) passes the objective checks but the verifier sees the real passage and its NOT_ENTAILED verdict withholds it', async () => {
  const claim = 'Du får gärna ta med en egen vattenflaska.';
  const entrance = passageWith('innergården, inte vid');
  const verifier = (sent: any) => {
    const out = approvingVerifier(s => [{ id: 'v1', description: 'x', kind: 'information', availableInSources: true, sourcesConflict: false, status: 'complete',
      coveredByUnits: s.map(u => u.id), missingInformation: [] }])(sent);
    return { ...out, units: out.units.map(u => ({ ...u, verdict: 'NOT_ENTAILED' as const })) };
  };
  const { result, calls } = await runOne([{ text: claim, modality: 'permitted', evidence: [entrance.ref] }], { verifier, question: 'Får jag ta med vatten?' });
  assert.ok(calls.find(c => c.role === 'verifier')!.input.includes(JSON.stringify(normalizeText(entrance.text))));
  assert.ok(result.reasons.some(r => r.code === 'VERIFIER_NOT_ENTAILED'));
  assert.ok(!result.text.includes('vattenflaska'));
});

test('a unit with an unknown reference never reaches the verifier, and the remaining verified unit is not presented as complete', async () => {
  const { result, calls } = await runOne([{ text: TEXT, evidence: [ARRIVE().ref] },
    { text: 'Entrén ligger på innergården.', modality: 'descriptive', evidence: ['E4000'] }]);
  assert.ok(result.reasons.some(r => r.code === 'EVIDENCE_REF_UNKNOWN' && r.unitId === 'u2'));
  assert.equal(sentUnits(calls.find(c => c.role === 'verifier')!).length, 1);
  assert.ok(!result.text.includes('innergården'));
});

test('conflicting evidence cited by unknown references cannot prove a conflict → SOURCE_CONFLICT (fails closed)', async () => {
  const verifier = (sent: any, _d: string, request: ProviderRequest) => {
    const out: any = approvingVerifier(s => [{ id: 'v1', description: 'x', kind: 'information', availableInSources: true, sourcesConflict: true, status: 'complete',
      coveredByUnits: s.map(u => u.id), missingInformation: [] }])(sent);
    return JSON.stringify({ obligations: out.obligations.map(({ conflictingQuotes: _q, ...o }: any) => ({ ...o, coveredByUnits: sentUnits(request).map(u => u.key),
      conflictingEvidence: ['E9000', 'E9001'] })), units: out.units.map(({ unitId: _u, ...v }: any, i: number) => ({ unitKey: `U${i + 1}`, ...v })), reply: out.reply });
  };
  const { result } = await runOne([{ text: TEXT, evidence: [ARRIVE().ref] }], { verifier });
  assert.deepEqual(result.reasons.filter(r => r.fatal).map(r => r.code), ['SOURCE_CONFLICT']);
});
