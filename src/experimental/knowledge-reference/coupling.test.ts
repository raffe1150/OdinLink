/** EXPERIMENTAL — coupled permission/restriction segments (Pilot 6 es-08 regression). SYNTHETIC scripted outputs; no model involved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runReferenceAnswer } from './pipeline';
import { pinCorpus } from './corpus';
import { coupleSegments } from './reply';
import { loadFixtureSources } from './eval/dataset';
import { approvingVerifier, currentRevalidation, scriptedProvider, sentUnits, type SentUnit } from './eval/scripted';
import type { AnswerOutput, AnswerUnit, ProviderRequest, VerifierOutput } from './types';

const sources = loadFixtureSources();
const BIKES = pinCorpus(3, sources).corpus!.evidence.passages.find(p => p.text.includes('Cyklar får parkeras'))!.ref;
const PERMIT = 'Sí, puedes aparcar tu bicicleta en los aparcabicis del patio interior.';
const RESTRICT = 'No está permitido dejarla delante de la entrada.';
const PAYMENT = 'No tengo información sobre las formas de pago que aceptamos.';
const seg = (id: string, text: string, modality: AnswerUnit['modality'], extra: Partial<AnswerUnit> = {}): AnswerUnit =>
  ({ id, text, modality, conditions: [], citations: [], evidence: [BIKES], addresses: ['o1'], ...extra });
const answer = (units: AnswerUnit[]): AnswerOutput => ({ language: 'es', draft: '', units,
  obligations: [{ id: 'o1', description: 'bici', status: 'answered' }, { id: 'o2', description: 'pago', status: 'not_in_sources' }] });
const es08 = (restriction = true): AnswerOutput => answer([seg('r1', PERMIT, 'permitted'), ...(restriction ? [seg('r2', RESTRICT, 'prohibited')] : []),
  { id: 'r3', kind: 'limitation', text: PAYMENT, modality: 'descriptive', conditions: [], citations: [], evidence: [], addresses: ['o2'], newParagraph: true }]);
const obligations = (s: readonly SentUnit[]) => [
  { id: 'O1', description: 'bike', kind: 'permission' as const, availableInSources: true, sourcesConflict: false, status: 'complete' as const,
    coveredByUnits: s.filter(u => u.kind !== 'limitation').map(u => u.id), missingInformation: [] },
  { id: 'O2', description: 'payment', kind: 'information' as const, availableInSources: false, sourcesConflict: false, status: 'not_addressed' as const,
    coveredByUnits: s.filter(u => u.kind === 'limitation').map(u => u.id), missingInformation: [] }];
/** Verdict as an independent verifier judges the TEXT it is sent: a permission without its source restriction drops a condition. */
const textVerifier = (override?: Partial<VerifierOutput['units'][number]>) => (sent: readonly SentUnit[], d: string) => {
  const o = approvingVerifier(obligations)(sent, d);
  return { ...o, units: o.units.map(v => {
    const t = sent.find(s => s.id === v.unitId)!.text;
    const dropped = t.includes('puedes aparcar') && !t.includes('delante de la entrada');
    return { ...v, ...(dropped ? { conditionsPreserved: false } : {}), ...(t.includes('puedes aparcar') ? override : {}) };
  }) };
};
async function run(a: AnswerOutput, verifier: ReturnType<typeof textVerifier>) {
  const calls: ProviderRequest[] = [];
  const result = await runReferenceAnswer({ businessId: 3, question: '¿Puedo dejar mi bicicleta allí y qué formas de pago aceptan?', language: 'es',
    history: [], sources }, { provider: scriptedProvider({ answer: a, verifier }, calls), revalidate: currentRevalidation(sources),
    timeouts: { answerMs: 2000, verifierMs: 2000 } });
  return { result, sent: sentUnits(calls.find(c => c.role === 'verifier')!) };
}

test('es-08 shape: a permission and its restriction from one passage are verified as ONE segment and published verbatim', async () => {
  const { result, sent } = await run(es08(), textVerifier());
  assert.equal(sent.length, 2, 'r1+r2 coupled, plus the limitation');
  assert.equal(sent[0].text, `${PERMIT} ${RESTRICT}`);
  assert.equal(result.publication, 'partial_draft', JSON.stringify(result.reasons));
  assert.equal(result.text, `${PERMIT} ${RESTRICT}\n\n${PAYMENT}`);
  assert.ok(result.reasons.some(r => r.code === 'SEGMENTS_COUPLED' && r.unitId === 'r2' && !r.fatal));
});

test('a negative verdict on the coupled segment is never bypassed: neither the permission nor the restriction is published', async () => {
  for (const override of [{ verdict: 'NOT_ENTAILED' as const }, { conditionsPreserved: false }, { modalityCorrect: false }]) {
    const { result } = await run(es08(), textVerifier(override));
    assert.ok(!result.text.includes(PERMIT) && !result.text.includes(RESTRICT), JSON.stringify(override));
    assert.notEqual(result.publication, 'partial_draft');
  }
});

test('a missing restriction still fails closed: the permission alone is judged to drop its condition and is withheld', async () => {
  const { result } = await run(es08(false), textVerifier());
  assert.ok(result.reasons.some(r => r.code === 'VERIFIER_CONDITIONS_DROPPED' && r.unitId === 'r1'));
  assert.ok(!result.text.includes(PERMIT));
  assert.equal(result.publication, 'fallback');
});

test('coupling is narrow: different paragraphs, no shared passage, or a limitation are never joined', () => {
  const w = (id: string, evidence: string[], extra = {}) => ({ id, kind: 'claim' as const, text: id, modality: 'descriptive' as const, conditions: [],
    evidence, addresses: [], newParagraph: false, ...extra });
  assert.equal(coupleSegments([w('a', ['E1']), w('b', ['E2'])]).reply.length, 2);
  assert.equal(coupleSegments([w('a', ['E1']), w('b', ['E1'], { newParagraph: true })]).reply.length, 2);
  assert.equal(coupleSegments([w('a', ['E1']), w('b', [], { kind: 'limitation' })]).reply.length, 2);
  const c = coupleSegments([w('a', ['E1'], { modality: 'permitted' }), w('b', ['E1', 'E2'], { modality: 'prohibited' }), w('c', ['E2'])]);
  assert.deepEqual(c.merged, ['b', 'c']);
  assert.deepEqual(c.reply[0].evidence, ['E1', 'E2']);
  assert.equal(c.reply[0].modality, 'descriptive', 'mixed force is not labelled as either; the verifier judges the text');
});
