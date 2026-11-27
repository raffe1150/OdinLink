import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRoutingUnderstanding } from './contract';
import { decideRoute, type ClassifierOutcome } from './policy';
import { RoutingBudgetRefused, SemanticRoutingRuntime, readSemanticRoutingConfig, type RoutingTurn } from './runtime';

const msg = 'Is it mandatory to arrive 10 minutes early?';
const wire = (o: Record<string, unknown> = {}) => ({ primaryIntent: 'business_information', secondaryIntents: [], confidence: 0.93, requestsMutation: false,
  asksInformation: true, confirmation: 'none', continuesActiveBooking: false, language: 'en', resolvedQuestion: msg, referencesResolved: false, languageSwitch: false, bookingRequest: { serviceMention: '', affirmative: false }, mixedParts: { informationSpan: '', bookingSpan: '', informationQuestion: '' },
  evidence: [{ quote: 'arrive 10 minutes', intent: 'business_information' }], ...o });
const ok = (o: Record<string, unknown> = {}, m = msg): ClassifierOutcome => {
  const d = decodeRoutingUnderstanding(wire(o), m); assert.ok(d.ok, JSON.stringify(d)); return { kind: 'ok', value: (d as any).value };
};
const none = { activeBooking: null }, legacy = { knowledgeAdmitted: false, explicitAction: false };
const active = (awaitingConfirmation = false) => ({ activeBooking: { phase: awaitingConfirmation ? 'awaiting_slot_confirmation' : 'awaiting_date_or_time', awaitingConfirmation } });

test('decoder v2: strict structure; verbatim quotes validated by normalized inclusion', () => {
  assert.equal(decodeRoutingUnderstanding(wire(), msg).ok, true);
  for (const bad of [null, [], 'x', { ...wire(), extra: 1 }, wire({ primaryIntent: 'book_now' }), wire({ confidence: 1.2 }), wire({ confidence: NaN }),
    wire({ secondaryIntents: ['business_information'] }), wire({ language: 'English' }), wire({ confirmation: 'yes' }), wire({ resolvedQuestion: '' }),
    wire({ resolvedQuestion: 'x'.repeat(601) }), wire({ referencesResolved: 'no' }), wire({ evidence: [{ quote: 1, intent: 'business_information' }] }),
    wire({ evidence: [{ quote: 'arrive', intent: 'business_information', start: 0 }] })])
    assert.equal(decodeRoutingUnderstanding(bad, msg).ok, false, JSON.stringify(bad));
});

test('decoder v2: imperfect evidence never rejects an information decision (the 11 genuine R1 rejections)', () => {
  for (const evidence of [[], [{ quote: 'something not in the message', intent: 'business_information' }], [{ quote: 'arrive', intent: 'cancellation' }]]) {
    const d = decodeRoutingUnderstanding(wire({ evidence }), msg);
    assert.ok(d.ok, JSON.stringify(evidence)); assert.equal((d as any).value.evidence.length, 0);
  }
  // Case, punctuation, whitespace, Arabic diacritics/tatweel and Persian ZWNJ differences still match (script-neutral normalization).
  const ar = 'متى يجب أن أصل قبل موعدي الأول؟';
  assert.equal((decodeRoutingUnderstanding(wire({ language: 'ar', resolvedQuestion: ar, evidence: [{ quote: 'يجب أنْ أصل', intent: 'business_information' }] }), ar) as any).value.evidence.length, 1);
  const fa = 'می‌خواهم برای سه‌شنبه ساعت ۲ وقت بگیرم.';
  const faWire = wire({ primaryIntent: 'new_booking', requestsMutation: true, asksInformation: false, language: 'fa', resolvedQuestion: fa, evidence: [{ quote: 'میخواهم برای سهشنبه', intent: 'new_booking' }] });
  assert.equal(decodeRoutingUnderstanding(faWire, fa).ok, true);
  assert.equal((decodeRoutingUnderstanding(wire({ evidence: [{ quote: 'ARRIVE   10 minutes!', intent: 'business_information' }] }), msg) as any).value.evidence.length, 1);
});

test('decoder v2: booking-lane intents stay strict; a quote from history or invented text is never action evidence', () => {
  const book = 'Kan jag boka en tid på tisdag klockan 14?';
  const base = { primaryIntent: 'new_booking', requestsMutation: true, asksInformation: false, language: 'sv', resolvedQuestion: book };
  assert.equal(decodeRoutingUnderstanding(wire({ ...base, evidence: [{ quote: 'boka en tid', intent: 'new_booking' }] }), book).ok, true);
  for (const evidence of [[], [{ quote: 'avboka min tid', intent: 'new_booking' }], [{ quote: 'boka en tid', intent: 'business_information' }]])
    assert.deepEqual(decodeRoutingUnderstanding(wire({ ...base, evidence }), book), { ok: false, reason: 'action_evidence_missing' });
  // mixed: the booking part must be grounded too
  const mixed = { primaryIntent: 'mixed', secondaryIntents: ['business_information', 'new_booking'], requestsMutation: true, asksInformation: true, language: 'sv', resolvedQuestion: book };
  assert.equal(decodeRoutingUnderstanding(wire({ ...mixed, evidence: [{ quote: 'tisdag', intent: 'business_information' }] }), book).ok, false);
});

test('policy: information admits knowledge, preserves an active booking', () => {
  assert.deepEqual([decideRoute(ok(), none, legacy).lane, decideRoute(ok(), none, legacy).knowledge], ['knowledge', 'admit']);
  const i = decideRoute(ok({ primaryIntent: 'knowledge_interruption', evidence: [{ quote: 'arrive 10 minutes', intent: 'knowledge_interruption' }] }), active(), legacy);
  assert.equal(i.lane, 'knowledge'); assert.equal(i.preserveBookingState, true);
  assert.equal(decideRoute(ok({ primaryIntent: 'booking_policy_question', evidence: [{ quote: 'arrive 10 minutes', intent: 'booking_policy_question' }] }), active(), legacy).lane, 'knowledge');
});

test('policy: confidence is necessary but never sufficient', () => {
  assert.equal(decideRoute(ok({ confidence: 0.79 }), none, legacy).lane, 'legacy');
  // high confidence but contradictory: information that also asks for a mutation
  assert.equal(decideRoute(ok({ confidence: 0.99, requestsMutation: true }), none, legacy).lane, 'clarify');
  assert.equal(decideRoute(ok({ confidence: 0.99, primaryIntent: 'cancellation', requestsMutation: false, evidence: [{ quote: 'arrive 10 minutes', intent: 'cancellation' }] }), none, legacy).lane, 'clarify');
});

test('policy: confirmation and continuation require matching booking state', () => {
  const conf = { primaryIntent: 'confirmation', confirmation: 'affirmed', requestsMutation: true, asksInformation: false, evidence: [{ quote: 'arrive 10 minutes', intent: 'confirmation' }] };
  assert.equal(decideRoute(ok(conf), none, legacy).lane, 'clarify');
  assert.equal(decideRoute(ok(conf), active(false), legacy).lane, 'clarify');
  assert.equal(decideRoute(ok(conf), active(true), legacy).lane, 'booking');
  assert.equal(decideRoute(ok({ ...conf, confirmation: 'none' }), active(true), legacy).lane, 'clarify');
  const cont = { primaryIntent: 'booking_continuation', continuesActiveBooking: true, asksInformation: false, evidence: [{ quote: 'arrive 10 minutes', intent: 'booking_continuation' }] };
  assert.equal(decideRoute(ok(cont), none, legacy).lane, 'clarify');
  assert.equal(decideRoute(ok(cont), active(), legacy).lane, 'booking');
});

test('policy: booking proposals hand off to the Booking Engine only; knowledge is denied', () => {
  const d = decideRoute(ok({ primaryIntent: 'new_booking', requestsMutation: true, asksInformation: false, evidence: [{ quote: 'arrive 10 minutes', intent: 'new_booking' }] }), none, legacy);
  assert.deepEqual([d.lane, d.knowledge], ['booking', 'deny']);
  assert.equal(decideRoute(ok({ primaryIntent: 'availability', requestsMutation: false, asksInformation: true, evidence: [{ quote: 'arrive 10 minutes', intent: 'availability' }] }), none, legacy).lane, 'booking');
});

test('policy: mixed is ordered information-then-booking; incomplete mixed clarifies', () => {
  const m = decideRoute(ok({ primaryIntent: 'mixed', secondaryIntents: ['business_information', 'new_booking'], requestsMutation: true,
    bookingRequest: { serviceMention: '', affirmative: true }, mixedParts: { informationSpan: 'Is it mandatory', bookingSpan: 'arrive 10 minutes early', informationQuestion: 'Is it mandatory to arrive early?' },
    evidence: [{ quote: 'arrive 10 minutes', intent: 'business_information' }, { quote: 'arrive 10 minutes', intent: 'new_booking' }] }), none, legacy);
  assert.deepEqual([m.lane, m.knowledge, [...m.order]], ['mixed', null, ['knowledge', 'booking']]);
  assert.equal(decideRoute(ok({ primaryIntent: 'mixed', secondaryIntents: ['business_information'], bookingRequest: { serviceMention: '', affirmative: false }, mixedParts: { informationSpan: 'Is it mandatory', bookingSpan: 'arrive 10 minutes early', informationQuestion: 'q' }, evidence: [{ quote: 'arrive 10 minutes', intent: 'business_information' }] }), none, legacy).lane, 'clarify');
  assert.deepEqual(m.parts, { informationSpan: 'Is it mandatory', bookingSpan: 'arrive 10 minutes early', informationQuestion: 'Is it mandatory to arrive early?' });
});

test('policy: provider failure and invalid output keep legacy behaviour', () => {
  for (const reason of ['timeout', 'provider_error', 'invalid', 'not_accounted', 'budget_refused'] as const)
    assert.equal(decideRoute({ kind: 'unavailable', reason }, none, legacy).lane, 'legacy');
});

const turn = (o: Partial<RoutingTurn> = {}): RoutingTurn => ({ businessId: 3, channel: 'telegram', conversationId: 'c1', turnKey: 't1', spendKey: 'a'.repeat(64), message: msg,
  context: none, legacy, ...o });
const counting = (output: unknown = wire(), delayMs = 0, fail?: 'refuse' | 'throw') => {
  const calls = { classify: 0 };
  return { calls, classifier: { classify: async (_i: unknown, id: any, signal: AbortSignal) => { calls.classify++;
      assert.match(id.requestKey, /^[a-f0-9]{64}$/);
      if (fail === 'refuse') throw new RoutingBudgetRefused();
      if (fail === 'throw') throw new Error('boom');
      if (delayMs) await new Promise((res, rej) => { const t = setTimeout(res, delayMs); signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }); });
      return { output }; } } };
};
const cfg = (env: Record<string, string | undefined>) => readSemanticRoutingConfig(env);

test('runtime: OFF and ineligible make no provider call and no reservation', async () => {
  for (const env of [{}, { ODINLINK_SEMANTIC_ROUTING_MODE: 'owner' }, { ODINLINK_SEMANTIC_ROUTING_MODE: 'owner', ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '3' },
    { ODINLINK_SEMANTIC_ROUTING_MODE: 'owner', ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '4', ODINLINK_SEMANTIC_ROUTING_OWNER_CONVERSATIONS: '3:telegram:c1' },
    { ODINLINK_SEMANTIC_ROUTING_MODE: 'shadow', ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '4' }, { ODINLINK_SEMANTIC_ROUTING_MODE: 'ON' }]) {
    const c = counting();
    const r = await new SemanticRoutingRuntime({ config: cfg(env), ...c }).route(turn());
    assert.equal(r.outcome, 'skipped'); assert.equal(r.applied, null); assert.deepEqual(c.calls, { classify: 0 }, JSON.stringify(env));
  }
});

test('runtime: SHADOW observes without applying; OWNER applies only for the allowlisted conversation', async () => {
  const seen: any[] = [];
  const s = counting();
  const shadow = await new SemanticRoutingRuntime({ config: cfg({ ODINLINK_SEMANTIC_ROUTING_MODE: 'shadow', ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '3' }), ...s, observe: o => seen.push(o) }).route(turn());
  assert.equal(shadow.applied, null); assert.equal(shadow.decision?.lane, 'knowledge'); assert.equal(seen[0].agreement, false);
  assert.ok(!JSON.stringify(seen).includes('mandatory'), 'observation is content-free');
  const o = counting();
  const owner = new SemanticRoutingRuntime({ config: cfg({ ODINLINK_SEMANTIC_ROUTING_MODE: 'owner', ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '3', ODINLINK_SEMANTIC_ROUTING_OWNER_CONVERSATIONS: '3:telegram:c1' }), ...o });
  assert.equal((await owner.route(turn())).applied?.lane, 'knowledge');
  assert.equal((await owner.route(turn({ conversationId: 'c2', turnKey: 'x' }))).outcome, 'skipped');
});

test('runtime: no accounted classifier means no dispatch; a refused hold dispatches nothing', async () => {
  const config = cfg({ ODINLINK_SEMANTIC_ROUTING_MODE: 'shadow', ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '3' });
  assert.equal((await new SemanticRoutingRuntime({ config, classifier: null }).route(turn())).decision?.reason, 'unavailable:not_accounted');
  const refused = counting(wire(), 0, 'refuse');
  assert.equal((await new SemanticRoutingRuntime({ config, ...refused }).route(turn())).decision?.reason, 'unavailable:budget_refused');
});

test('runtime: timeout, provider failure and invalid output fall back to legacy', async () => {
  const config = cfg({ ODINLINK_SEMANTIC_ROUTING_MODE: 'owner', ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '3', ODINLINK_SEMANTIC_ROUTING_OWNER_CONVERSATIONS: '3:telegram:c1', ODINLINK_SEMANTIC_ROUTING_TIMEOUT_MS: '30' });
  const t = await new SemanticRoutingRuntime({ config, ...counting(wire(), 200) }).route(turn());
  assert.equal(t.decision?.reason, 'unavailable:timeout'); assert.equal(t.applied, null);
  const f = await new SemanticRoutingRuntime({ config, ...counting(wire(), 0, 'throw') }).route(turn());
  assert.equal(f.decision?.reason, 'unavailable:provider_error'); assert.equal(f.applied, null);
  const i = await new SemanticRoutingRuntime({ config, ...counting({ nonsense: true }) }).route(turn());
  assert.equal(i.decision?.reason, 'unavailable:invalid'); assert.equal(i.applied, null);
});

test('runtime: duplicate delivery of the same turn classifies and reserves once', async () => {
  const c = counting();
  const rt = new SemanticRoutingRuntime({ config: cfg({ ODINLINK_SEMANTIC_ROUTING_MODE: 'owner', ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '3', ODINLINK_SEMANTIC_ROUTING_OWNER_CONVERSATIONS: '3:telegram:c1' }), ...c });
  const [x, y] = await Promise.all([rt.route(turn()), rt.route(turn())]);
  assert.equal(x, y); assert.equal(c.calls.classify, 1);
});

test('decoder v2 mixed parts: verbatim, distinct, standalone information question; ignored for non-mixed decisions', () => {
  const m = 'Is there parking close by, and could you book me in for Monday morning?';
  const base = { primaryIntent: 'mixed', secondaryIntents: ['business_information', 'new_booking'], requestsMutation: true, asksInformation: true, resolvedQuestion: m,
    evidence: [{ quote: 'parking close by', intent: 'business_information' }, { quote: 'book me in', intent: 'new_booking' }] };
  const good = decodeRoutingUnderstanding(wire({ ...base, bookingRequest: { serviceMention: '', affirmative: false }, mixedParts: { informationSpan: 'Is there parking close by', bookingSpan: 'could you book me in for Monday morning', informationQuestion: 'Is there parking close to the studio?' } }), m);
  assert.ok(good.ok); assert.equal((good as any).value.mixedParts.bookingSpan, 'could you book me in for Monday morning');
  for (const mixedParts of [
    { informationSpan: '', bookingSpan: 'could you book me in', informationQuestion: 'q' },                        // missing part
    { informationSpan: 'Is there parking close by', bookingSpan: 'please book Tuesday', informationQuestion: 'q' }, // invented booking words
    { informationSpan: 'Is there parking close by', bookingSpan: 'Is there parking close by', informationQuestion: 'q' }, // not distinct
    { informationSpan: 'Is there parking close by', bookingSpan: 'could you book me in', informationQuestion: ' ' }]) // no standalone question
    assert.deepEqual(decodeRoutingUnderstanding(wire({ ...base, mixedParts }), m), { ok: false, reason: 'mixed_parts_invalid' }, JSON.stringify(mixedParts));
  assert.equal(decodeRoutingUnderstanding(wire({ ...base, bookingRequest: { serviceMention: '', affirmative: false }, mixedParts: null }), m).ok, false);
  const info = decodeRoutingUnderstanding(wire({ bookingRequest: { serviceMention: '', affirmative: false }, mixedParts: { informationSpan: 'x', bookingSpan: 'y', informationQuestion: 'z' } }), msg);
  assert.ok(info.ok); assert.equal((info as any).value.mixedParts, null);
});

test('decoder v2 bookingRequest: service words verbatim from the booking text or none; never a person; affirmative flag carried', () => {
  const m = 'Could you book me in for Monday morning?';
  const book = { primaryIntent: 'new_booking', requestsMutation: true, asksInformation: false, resolvedQuestion: m, evidence: [{ quote: 'book me in', intent: 'new_booking' }] };
  const none = decodeRoutingUnderstanding(wire({ ...book, bookingRequest: { serviceMention: '', affirmative: true } }), m);
  assert.ok(none.ok); assert.deepEqual((none as any).value.bookingRequest, { intent: 'new_booking', serviceMention: null, affirmative: true });
  const d = decideRoute({ kind: 'ok', value: (none as any).value }, { activeBooking: null }, legacy);
  assert.equal(d.lane, 'booking'); assert.deepEqual(d.booking, { intent: 'new_booking', serviceMention: null, affirmative: true });
  const m2 = 'Kan jag boka en Video Consultation på fredag?';
  const named = decodeRoutingUnderstanding(wire({ ...book, resolvedQuestion: m2, evidence: [{ quote: 'boka en Video Consultation', intent: 'new_booking' }], bookingRequest: { serviceMention: 'Video Consultation', affirmative: true } }), m2);
  assert.ok(named.ok); assert.equal((named as any).value.bookingRequest.serviceMention, 'Video Consultation');
  assert.deepEqual(decodeRoutingUnderstanding(wire({ ...book, bookingRequest: { serviceMention: 'Laser treatment', affirmative: true } }), m), { ok: false, reason: 'booking_request_invalid' });
  for (const bad of [null, {}, { serviceMention: 1, affirmative: true }, { serviceMention: '' }, { serviceMention: '', affirmative: 'yes' }, { serviceMention: '', affirmative: true, extra: '' }])
    assert.deepEqual(decodeRoutingUnderstanding(wire({ ...book, bookingRequest: bad }), m), { ok: false, reason: 'invalid_field' }, JSON.stringify(bad));
  const info = decodeRoutingUnderstanding(wire({ bookingRequest: { serviceMention: 'arrive', affirmative: true } }), msg);
  assert.ok(info.ok); assert.equal((info as any).value.bookingRequest, null);
});

test('mixed consent safety: overlapping, repeated or under-covering parts are refused; non-affirmative or non-start booking parts keep the full message', () => {
  const mm = 'Is there parking close by, and could you book me in for Monday morning?';
  const mixed = (parts: any, booking: any = { serviceMention: '', affirmative: true }, intents = ['business_information', 'new_booking'], m = mm) =>
    decodeRoutingUnderstanding(wire({ primaryIntent: 'mixed', secondaryIntents: intents, requestsMutation: true, asksInformation: true, resolvedQuestion: m,
      evidence: [{ quote: 'parking', intent: 'business_information' }, { quote: m.includes('book') ? 'book' : m.slice(-10), intent: intents[1] }], bookingRequest: booking, mixedParts: parts }), m);
  const ok = mixed({ informationSpan: 'Is there parking close by', bookingSpan: 'could you book me in for Monday morning', informationQuestion: 'Is there parking close to the studio?' });
  assert.ok(ok.ok);
  assert.equal(decideRoute({ kind: 'ok', value: (ok as any).value }, { activeBooking: null }, legacy).lane, 'mixed');
  // overlapping spans (the booking span re-uses words of the information span)
  assert.deepEqual(mixed({ informationSpan: 'Is there parking close by, and could you', bookingSpan: 'could you book me in for Monday morning', informationQuestion: 'q?' }), { ok: false, reason: 'mixed_parts_invalid' });
  // omitted qualifier: the condition is outside both parts
  const cond = 'Is there parking close by? Book me in for Monday morning, but only if Dr Lind is the one treating me and it is before nine.';
  assert.deepEqual(mixed({ informationSpan: 'Is there parking close by', bookingSpan: 'Book me in for Monday morning', informationQuestion: 'q?' }, undefined, undefined, cond), { ok: false, reason: 'mixed_parts_invalid' });
  // a span occurring twice is ambiguous
  const twice = 'Book me in, is there parking, book me in';
  assert.deepEqual(mixed({ informationSpan: 'is there parking', bookingSpan: 'book me in', informationQuestion: 'q?' }, undefined, undefined, twice), { ok: false, reason: 'mixed_parts_invalid' });
  // negated / conditional booking part (Sol: affirmative false) → full message, legacy path; never a fragment-driven booking
  const neg = "Is there parking close by? Don't book me in for Monday yet.";
  const n = mixed({ informationSpan: 'Is there parking close by', bookingSpan: "Don't book me in for Monday yet", informationQuestion: 'q?' }, { serviceMention: '', affirmative: false }, undefined, neg);
  assert.ok(n.ok); assert.deepEqual([decideRoute({ kind: 'ok', value: (n as any).value }, { activeBooking: null }, legacy).lane, decideRoute({ kind: 'ok', value: (n as any).value }, { activeBooking: null }, legacy).reason], ['legacy', 'mixed_requires_full_message']);
  // a consent-bearing operation (cancellation / reschedule / confirmation) is never split
  const can = 'Is there parking close by, and please cancel my appointment';
  const c = mixed({ informationSpan: 'Is there parking close by', bookingSpan: 'please cancel my appointment', informationQuestion: 'q?' }, { serviceMention: '', affirmative: true }, ['business_information', 'cancellation'], can);
  assert.ok(c.ok); assert.equal(decideRoute({ kind: 'ok', value: (c as any).value }, { activeBooking: null }, legacy).lane, 'legacy');
});

test('measured Sol understanding timeout: default 6 s (genuine max 5.05 s), operator override capped at 8 s', () => {
  assert.equal(readSemanticRoutingConfig({}).timeoutMs, 6_000);
  assert.equal(readSemanticRoutingConfig({ ODINLINK_SEMANTIC_ROUTING_TIMEOUT_MS: '7000' }).timeoutMs, 7_000);
  assert.equal(readSemanticRoutingConfig({ ODINLINK_SEMANTIC_ROUTING_TIMEOUT_MS: '60000' }).timeoutMs, 8_000);
  assert.equal(readSemanticRoutingConfig({ ODINLINK_SEMANTIC_ROUTING_TIMEOUT_MS: 'x' }).timeoutMs, 6_000);
});
