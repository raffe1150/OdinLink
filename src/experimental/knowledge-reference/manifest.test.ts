/** EXPERIMENTAL — protocol v2 binding safety (SYNTHETIC adversarial verifier responses; no model involved). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindVerdicts, buildManifest, manifestIntact, segmentHash, unitHash } from './manifest';
import { parseVerifier } from './contracts';
import { runReferenceAnswer } from './pipeline';
import { requestSha256 } from './wire';
import { loadDataset, loadFixtureSources } from './eval/dataset';
import { approvingVerifier, currentRevalidation, revisions, scriptedProvider, toWire, sentUnits } from './eval/scripted';
import type { AnswerUnit, ProviderRequest, VerifierWireOutput } from './types';

const dataset = loadDataset();
const sources = loadFixtureSources();
const rev = revisions(sources);
const unit = (id: string, text: string, fact: string): AnswerUnit => ({ id, text, modality: 'descriptive', conditions: [], addresses: [],
  citations: [{ sourceId: dataset.facts[fact].sourceId, revision: rev[dataset.facts[fact].sourceId], quote: dataset.facts[fact].quote }] });
const units = [unit('u1', 'Entrén ligger på innergården, inte vid huvudingången mot gatan.', 'ENTRANCE_COURTYARD'),
  unit('u2', 'Det finns hiss i byggnaden och den nås via innergårdens högra sida.', 'LIFT'),
  unit('u3', 'Cyklar får parkeras vid cykelställen på innergården, men inte framför entrén.', 'BIKES')];
const verdict = (unitKey: string, extra = {}) => ({ unitKey, verdict: 'ENTAILED' as const, modalityCorrect: true, conditionsPreserved: true,
  languageCorrect: true, unsupportedAdditions: [], independentOfConflicts: true, ...extra });
const wire = (keys: string[], covered: string[] = keys): VerifierWireOutput => ({
  obligations: [{ id: 'o1', description: 'x', kind: 'location', availableInSources: true, sourcesConflict: false, conflictingEvidence: [], status: 'complete',
    coveredByUnits: covered, missingInformation: [] }],
  units: keys.map(k => verdict(k)), reply: { misleadingAsWhole: false } });

test('manifest: software-assigned keys, deep-frozen snapshots, stable id; duplicate unit ids are refused', () => {
  const m = buildManifest(units, 'utkast');
  assert.deepEqual(m.entries.map(e => [e.key, e.unitId]), [['U1', 'u1'], ['U2', 'u2'], ['U3', 'u3']]);
  assert.equal(m.entries[1].hash, segmentHash(units[1]));
  // Protocol v3: structure is bound too — the same text as a limitation, or starting a new paragraph, is a different segment.
  assert.notEqual(segmentHash({ ...units[1], newParagraph: true }), segmentHash(units[1]));
  assert.notEqual(segmentHash({ ...units[1], kind: 'limitation' }), segmentHash(units[1]));
  assert.notEqual(buildManifest([units[1], units[0], units[2]], 'utkast').id, m.id, 'order is bound');
  assert.ok(unitHash(units[1]).startsWith('u_'), 'the v1 unit hash is kept for historical replay');
  assert.equal(buildManifest(units, 'utkast').id, m.id);
  assert.notEqual(buildManifest(units, 'annat utkast').id, m.id);
  assert.throws(() => { (m.entries[0].unit as any).text = 'ändrad'; }, TypeError);
  assert.throws(() => { (m.entries[0].unit.citations[0] as any).quote = 'x'; }, TypeError);
  assert.throws(() => buildManifest([units[0], units[0]], ''), /MANIFEST_DUPLICATE_UNIT_ID/u);
});

test('binding: exact key set required — duplicate, missing and unknown keys fail closed with a precise detail', () => {
  const m = buildManifest(units, '');
  assert.deepEqual(bindVerdicts(m, wire(['U1', 'U1', 'U3'])).failure, { code: 'VERIFIER_BINDING_MISMATCH', detail: 'duplicate:U1' });
  assert.deepEqual(bindVerdicts(m, wire(['U1', 'U3'])).failure, { code: 'VERIFIER_BINDING_MISMATCH', detail: 'missing:U2' });
  assert.deepEqual(bindVerdicts(m, wire(['U1', 'U2', 'U3', 'U4'])).failure, { code: 'VERIFIER_BINDING_MISMATCH', detail: 'unknown:U4' });
  assert.deepEqual(bindVerdicts(m, wire(['U1', 'U2', 'U3'], ['U1', 'U7'])).failure, { code: 'VERIFIER_OBLIGATION_UNIT_UNKNOWN', detail: 'unknown:U7', obligationId: 'o1' });
});

test('binding: malformed keys (model-invented ids, hashes, answer ids) are rejected by the strict contract before binding', () => {
  for (const bad of ['u1', 'U0', 'U1 ', 'u_3172cba1d2d5092dc067670f', 'U01', 'U1000']) {
    const w = wire(['U1', 'U2', 'U3']);
    assert.equal(parseVerifier(JSON.stringify({ ...w, units: [verdict(bad), ...w.units.slice(1)] })), undefined, bad);
  }
  assert.equal(parseVerifier(JSON.stringify({ ...wire(['U1']), units: [{ ...verdict('U1'), unitHash: 'u_x' }] })), undefined, 'hash fields are not part of v2');
});

test('binding: reordered verdicts bind to the same units; translation uses the manifest, never model text', () => {
  const m = buildManifest(units, '');
  const r = bindVerdicts(m, { ...wire(['U3', 'U1', 'U2']), units: [verdict('U3', { verdict: 'NOT_ENTAILED' }), verdict('U1'), verdict('U2')] }).output!;
  assert.deepEqual(r.units.map(u => [u.unitId, u.verdict]), [['u3', 'NOT_ENTAILED'], ['u1', 'ENTAILED'], ['u2', 'ENTAILED']]);
  assert.deepEqual(r.obligations[0].coveredByUnits, ['u3', 'u1', 'u2']);
});

test('LIMITATION (documented): a semantic swap with valid keys binds by key — no identifier scheme can detect it; v1 hash echo could not either', () => {
  const m = buildManifest(units, '');
  const swapped = { ...wire(['U1', 'U2', 'U3']), units: [verdict('U1', { verdict: 'NOT_ENTAILED' }), verdict('U2'), verdict('U3')] };
  const r = bindVerdicts(m, swapped).output!;
  assert.equal(r.units.find(u => u.unitId === 'u1')!.verdict, 'NOT_ENTAILED'); // the verdict follows the key the model wrote
});

test('integrity: altered unit content, an altered citation, a stale manifest or a substituted draft are detected before publication', () => {
  const m = buildManifest(units, 'Utkast A');
  assert.equal(manifestIntact(m, units, 'Utkast A'), true);
  assert.equal(manifestIntact(m, [{ ...units[0], text: units[0].text + ' Alltid gratis.' }, units[1], units[2]], 'Utkast A'), false);
  assert.equal(manifestIntact(m, [{ ...units[0], citations: [{ ...units[0].citations[0], revision: 'r_stale' }] }, units[1], units[2]], 'Utkast A'), false);
  assert.equal(manifestIntact(m, units.slice(0, 2), 'Utkast A'), false);
  assert.equal(manifestIntact(m, units, 'Utkast B'), false, 'draft substitution');
  const stale = buildManifest([units[0], units[1], { ...units[2], text: 'Cyklar får parkeras överallt.' }], 'Utkast A');
  assert.equal(manifestIntact(stale, units, 'Utkast A'), false, 'stale manifest');
});

test('cross-request verdicts: a verdict set made for another request is refused (key set), and so is a result correlated to another request body', async () => {
  const c = dataset.cases.find(x => x.id === 'sv-04')!;
  const answer = { language: 'sv' as const, draft: units[0].text, obligations: [{ id: 'a1', description: 'x', status: 'answered' as const }], units: [units[0]] };
  const base = { businessId: 3, question: c.question, language: 'sv' as const, history: [], sources };
  const opts = (provider: any) => ({ provider, revalidate: currentRevalidation(sources), timeouts: { answerMs: 1000, verifierMs: 1000 } });
  // (a) verdicts for a 3-unit manifest sent in reply to a 1-unit request
  const foreign = scriptedProvider({ answer, verifierRaw: true, verifier: async (r: ProviderRequest) =>
    ({ text: JSON.stringify(wire(['U1', 'U2', 'U3'], ['U1'])), status: 'completed' as const, model: 's', requestSha256: requestSha256(r) }) });
  const a = await runReferenceAnswer(base, opts(foreign));
  assert.deepEqual(a.reasons.filter(r => r.fatal).map(r => [r.code, r.detail]), [['VERIFIER_BINDING_MISMATCH', 'unknown:U2']]);
  // (b) a perfectly valid verdict set, but the transport correlates it to a different request body
  const valid = (r: ProviderRequest) => JSON.stringify(toWire(approvingVerifier(s => [{ id: 'o1', description: 'x', kind: 'location', availableInSources: true,
    sourcesConflict: false, status: 'complete', coveredByUnits: s.map(u => u.id), missingInformation: [] }])(sentUnits(r, answer)), sentUnits(r, answer), r));
  const misrouted = scriptedProvider({ answer, verifierRaw: true, verifier: async (r: ProviderRequest) =>
    ({ text: valid(r), status: 'completed' as const, model: 's', requestSha256: requestSha256({ ...r, input: r.input + ' ' }) }) });
  const b = await runReferenceAnswer(base, opts(misrouted));
  assert.deepEqual(b.reasons.filter(r => r.fatal).map(r => r.code), ['REQUEST_CORRELATION_MISMATCH']);
  // (c) the same valid set, correctly correlated, publishes
  const ok = scriptedProvider({ answer, verifierRaw: true, verifier: async (r: ProviderRequest) => ({ text: valid(r), status: 'completed' as const, model: 's', requestSha256: requestSha256(r) }) });
  assert.equal((await runReferenceAnswer(base, opts(ok))).publication, 'complete_draft');
});

test('the verifier request carries no hashes and no answer unit ids; the model never needs to reproduce an opaque identifier', async () => {
  const calls: ProviderRequest[] = [];
  const c = dataset.cases.find(x => x.id === 'sv-04')!;
  const answer = { language: 'sv' as const, draft: units[0].text, obligations: [{ id: 'a1', description: 'x', status: 'answered' as const }], units: [{ ...units[0], id: 'answer-unit-zz' }] };
  await runReferenceAnswer({ businessId: 3, question: c.question, language: 'sv', history: [], sources },
    { provider: scriptedProvider({ answer, verifier: approvingVerifier(s => [{ id: 'o1', description: 'x', kind: 'location', availableInSources: true,
      sourcesConflict: false, status: 'complete', coveredByUnits: s.map(u => u.id), missingInformation: [] }]) }, calls),
      revalidate: currentRevalidation(sources), timeouts: { answerMs: 1000, verifierMs: 1000 } });
  const v = calls.find(x => x.role === 'verifier')!;
  assert.ok(!/u_[a-f0-9]{24}|d_[a-f0-9]{24}|unitHash|draftHash/u.test(v.input + v.instructions));
  assert.ok(!v.input.includes('answer-unit-zz'));
  assert.ok(v.input.includes('"unitKey":"U1"'));
});
