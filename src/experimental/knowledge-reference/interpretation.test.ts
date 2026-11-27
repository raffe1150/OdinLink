/** Sol-first hand-off: the understanding stage's resolved question reaches the answerer and the verifier as a bounded aid only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pinCorpus } from './corpus';
import { answerInput, verifierInput } from './prompts';
import { buildManifest } from './manifest';
import { customerSuppliedNumbers, runReferenceAnswer } from './pipeline';
import { loadDataset, loadFixtureSources } from './eval/dataset';

const d = loadDataset();
const corpus = pinCorpus(d.businessId, loadFixtureSources()).corpus!;
const base = { question: 'Kan jag reservera en plats där?', language: 'sv' as const,
  history: [{ role: 'user' as const, content: 'Finns det parkering nära er?' }, { role: 'assistant' as const, content: 'Ja, Nordpark på Stjärngatan 14.' }], corpus };

test('without an interpretation the answer and verifier inputs are byte-identical to the validated protocol', () => {
  assert.equal(answerInput(base), answerInput({ ...base, interpretation: undefined }));
  const manifest = buildManifest([], '', corpus.evidence.id);
  assert.equal(verifierInput({ ...base, manifest }), verifierInput({ ...base, manifest, interpretation: undefined }));
  assert.ok(!answerInput(base).includes('Contextual interpretation'));
});
test('with an interpretation: present after the customer message in BOTH answer and verifier input, labelled as an aid, never evidence', () => {
  const interpretation = 'Kan jag reservera en parkeringsplats i Nordpark nära er?';
  const a = answerInput({ ...base, interpretation }), v = verifierInput({ ...base, manifest: buildManifest([], '', corpus.evidence.id), interpretation });
  for (const text of [a, v]) {
    assert.ok(text.indexOf("Customer's latest message") < text.indexOf('Contextual interpretation'));
    assert.match(text, /customer's own message prevails, every condition in it must still be honoured, and this is never evidence/);
  }
});
test('numbers that appear only in the interpretation are never treated as customer-supplied', () => {
  assert.equal(customerSuppliedNumbers('Kan jag reservera en plats där?', base.history, 'sv').has(30), false);
});
test('the pipeline forwards a bounded interpretation to both calls and ignores an oversized one', async () => {
  const seen: string[] = [];
  const provider = async (r: any) => { seen.push(r.input); throw new Error('stop'); };
  await runReferenceAnswer({ businessId: d.businessId, question: base.question, language: 'sv', history: base.history, sources: loadFixtureSources(),
    interpretation: 'Kan jag reservera en parkeringsplats?' }, { provider, revalidate: async () => true, timeouts: { answerMs: 1000, verifierMs: 1000 } } as any).catch(() => undefined);
  assert.ok(seen[0]?.includes('Kan jag reservera en parkeringsplats?'));
  seen.length = 0;
  await runReferenceAnswer({ businessId: d.businessId, question: base.question, language: 'sv', history: base.history, sources: loadFixtureSources(),
    interpretation: 'x'.repeat(601) }, { provider, revalidate: async () => true, timeouts: { answerMs: 1000, verifierMs: 1000 } } as any).catch(() => undefined);
  assert.ok(seen[0] && !seen[0].includes('Contextual interpretation'));
});
