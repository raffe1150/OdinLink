/** Complete-snapshot results stay bound to the EXACT authorized source membership through finalization AND delivery (Phase 3).
 * Exact comparison (snapshot pin), no timestamps. Results without the pin keep the original per-source behaviour. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeAuthority } from './knowledge-authority';
import { knowledgeSourceRevision, type KnowledgeSource } from '../../knowledge';
import { resultDigest, type KnowledgeTask, type VerifiedKnowledge } from './knowledge-lifecycle';
import { CORPUS_PIN_ID, SNAPSHOT_PIN_ID, snapshotRevision } from './reference-snapshot';

const accepted = Date.parse('2026-11-25T20:00:00.000Z');
const src = (id: string, over: Partial<KnowledgeSource> = {}): KnowledgeSource => ({ id, businessId: 77, type: 'text', title: id, status: 'ready',
  content: `Content ${id}.`, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', metadata: {} as any, ...over });
const pins = (l: KnowledgeSource[]) => l.map(s => ({ id: s.id, revision: knowledgeSourceRevision(s) }));
function fixture(protocol: VerifiedKnowledge['protocol'], sources: { id: string; revision: string }[], live: () => KnowledgeSource[]) {
  const result = { protocol, independentlyVerified: true, completeRequiredFacts: protocol === 'evidence-first-v2', text: 'I have no information about that.', sources } as VerifiedKnowledge;
  const task = { id: 't', turnId: 'turn', eventId: 'e', acceptedAt: accepted, expiresAt: accepted + 75_000, input: { question: 'Hours?', language: 'en', history: [] },
    state: 'VERIFIED', revision: 1, fence: 1, lease: null, runAttempts: 1, maxRunAttempts: 3, modelAttempts: 2, maxModelAttempts: 4, checkpoint: 'extraction',
    scope: { businessId: 77, conversationId: 'c', channel: 'whatsapp', providerAccount: 'a' }, sequence: 1, result, resultDigest: resultDigest(result) } as KnowledgeTask;
  const row = { conversation_key: 'k', knowledge_channel: 'whatsapp', knowledge_account: 'a', knowledge_sequence: 1 };
  const db = { rpc: () => assert.fail('no writes'), from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row, error: null }) }; return q; } };
  return { task, authority: createKnowledgeAuthority(db as any, { list: async () => live() }, { canonicalConversationKey: async () => 'k', eligible: async () => true }) };
}
const SNAP = [src('a'), src('b')];
const snapshotPins = (l: KnowledgeSource[]) => [...pins(l), { id: SNAPSHOT_PIN_ID, revision: snapshotRevision(pins(l)) }];

test('unchanged snapshot: a verified absence is publishable at finalization and delivery', async () => {
  const f = fixture('evidence-first-partial-v1', snapshotPins(SNAP), () => SNAP);
  assert.equal(await f.authority(f.task, 'finalize'), true);
  assert.equal(await f.authority(f.task, 'send'), true);
});
for (const [name, live] of [
  ['source added', () => [...SNAP, src('c')]],
  ['source committed later with an OLD timestamp (transaction began before the task)', () => [...SNAP, src('c', { updatedAt: '2026-11-25T19:59:00.000Z' })]],
  ['source became ready', () => [...SNAP, src('c', { status: 'ready' })]],
  ['source processing', () => [...SNAP, src('c', { status: 'processing' as any })]],
  ['source failed extraction', () => [...SNAP, src('c', { status: 'failed' as any })]],
  ['pinned source modified', () => [src('a', { content: 'Changed.' }), src('b')]],
  ['pinned source removed', () => [src('a')]],
  ['pinned source disabled', () => [src('a'), src('b', { status: 'disabled' as any })]],
] as [string, () => KnowledgeSource[]][]) test(`snapshot race: ${name} between finalization and delivery → rejected`, async () => {
  let phase = 0;
  const f = fixture('evidence-first-partial-v1', snapshotPins(SNAP), () => (phase++ === 0 ? SNAP : live()));
  assert.equal(await f.authority(f.task, 'finalize'), true);
  assert.equal(await f.authority(f.task, 'send'), false);
});
test('a tampered snapshot pin (membership digest does not match its pins) is rejected', async () => {
  const f = fixture('evidence-first-partial-v1', [...pins(SNAP), { id: SNAPSHOT_PIN_ID, revision: snapshotRevision(pins([SNAP[0]])) }], () => SNAP);
  assert.equal(await f.authority(f.task, 'finalize'), false);
});
test('other tenants never affect a snapshot; results WITHOUT the pin keep the original behaviour (old engine unchanged when OFF)', async () => {
  const other = fixture('evidence-first-partial-v1', snapshotPins(SNAP), () => [...SNAP, src('x', { businessId: 88 })]);
  assert.equal(await other.authority(other.task, 'send'), true);
  const legacyPartial = fixture('evidence-first-partial-v1', pins([SNAP[0]]), () => [...SNAP, src('c', { updatedAt: '2026-11-25T20:00:30.000Z' })]);
  assert.equal(await legacyPartial.authority(legacyPartial.task, 'send'), true, 'Phase 2 timestamp rule removed: old-engine partials as before');
  const complete = fixture('evidence-first-v2', pins([SNAP[0]]), () => [...SNAP, src('c')]);
  assert.equal(await complete.authority(complete.task, 'send'), true);
});

// Phase 5: complete Reference answers carry the cited sources PLUS the corpus pin (digest of the whole authorized corpus).
const corpusPins = (cited: KnowledgeSource[], corpus: KnowledgeSource[]) => [...pins(cited), { id: CORPUS_PIN_ID, revision: snapshotRevision(pins(corpus)) }];
test('complete answer, unchanged corpus: publishable at finalization and delivery', async () => {
  const f = fixture('evidence-first-v2', corpusPins([SNAP[0]], SNAP), () => SNAP);
  assert.equal(await f.authority(f.task, 'finalize'), true);
  assert.equal(await f.authority(f.task, 'send'), true);
});
for (const [name, live] of [
  ['source added', () => [...SNAP, src('c')]],
  ['conflicting information added (new source contradicting the cited one)', () => [...SNAP, src('c', { content: 'Arrive 30 minutes early (supersedes earlier guidance).' })]],
  ['uncited source modified', () => [SNAP[0], src('b', { content: 'Changed.' })]],
  ['cited source modified', () => [src('a', { content: 'Changed.' }), SNAP[1]]],
  ['uncited source removed', () => [SNAP[0]]],
  ['source became ready', () => [...SNAP, src('c', { status: 'ready' })]],
  ['source processing', () => [...SNAP, src('c', { status: 'processing' as any })]],
  ['source failed', () => [...SNAP, src('c', { status: 'failed' as any })]],
  ['uncited source disabled', () => [SNAP[0], src('b', { status: 'disabled' as any })]],
] as [string, () => KnowledgeSource[]][]) test(`complete answer race: ${name} between finalization and delivery → rejected`, async () => {
  let phase = 0;
  const f = fixture('evidence-first-v2', corpusPins([SNAP[0]], SNAP), () => (phase++ === 0 ? SNAP : live()));
  assert.equal(await f.authority(f.task, 'finalize'), true);
  assert.equal(await f.authority(f.task, 'send'), false);
});
test('complete answer: tampered corpus pin, both reserved pins, and cross-tenant isolation', async () => {
  const tampered = fixture('evidence-first-v2', corpusPins([SNAP[0]], [SNAP[0]]), () => SNAP);
  assert.equal(await tampered.authority(tampered.task, 'finalize'), false);
  const both = fixture('evidence-first-v2', [...corpusPins([SNAP[0]], SNAP), { id: SNAPSHOT_PIN_ID, revision: snapshotRevision(pins(SNAP)) }], () => SNAP);
  assert.equal(await both.authority(both.task, 'finalize'), false);
  const other = fixture('evidence-first-v2', corpusPins([SNAP[0]], SNAP), () => [...SNAP, src('x', { businessId: 88 }), src('y', { businessId: 88, status: 'processing' as any })]);
  assert.equal(await other.authority(other.task, 'send'), true);
});
