/** Mixed knowledge + booking turns through the real native path in six languages. OWNER: the semantic split routes the information part
 * to knowledge and the booking part to the Booking Engine, whose reply is sent at once through the channel's ACKNOWLEDGED send; the
 * knowledge reply follows as its own message. Fragments are routing aids only: never consent, never mutation authority. OFF keeps the
 * existing behaviour. SCRIPTED classifier: mechanics only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentConfig, incidentInbound, interceptedIncidentSend } from '../../../../tests/helpers/p0-incident-knowledge';
Object.assign(process.env, { NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', AI_PROVIDER: 'gemini', ODINLINK_EVIDENCE_FIRST_KNOWLEDGE: 'true',
  ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '77', ODINLINK_ASYNC_KNOWLEDGE_ADMISSION: 'false',
  ODINLINK_ASYNC_KNOWLEDGE_PROCESSING: 'false', ODINLINK_ASYNC_KNOWLEDGE_DELIVERY: 'false', ODINLINK_SMART_WAITING: 'false' });
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../../../server');
const { SemanticRoutingRuntime, readSemanticRoutingConfig } = await import('./runtime');

const RECIPIENT = '46700000001';
const MIXED: Record<string, string> = { en: 'Where is parking, and please book an appointment for me.', sv: 'Var finns parkering? Boka en tid åt mig.',
  de: 'Wo kann ich parken? Bitte buchen Sie einen Termin.', es: '¿Dónde puedo aparcar? Quiero reservar una cita.',
  fa: 'پارکینگ کجاست؟ لطفاً برای من نوبت رزرو کنید.', ar: 'أين موقف السيارات؟ احجز لي موعداً.' };
/** Semantic parts: the customer's own words for each part (as Sol returns them in routing-v2). */
const PARTS: Record<string, [string, string]> = {
  en: ['Where is parking', 'please book an appointment for me'], sv: ['Var finns parkering?', 'Boka en tid åt mig.'],
  de: ['Wo kann ich parken?', 'Bitte buchen Sie einen Termin.'], es: ['¿Dónde puedo aparcar?', 'Quiero reservar una cita.'],
  fa: ['پارکینگ کجاست؟', 'لطفاً برای من نوبت رزرو کنید.'], ar: ['أين موقف السيارات؟', 'احجز لي موعداً.'],
};
/** Phrasings the lexical splitter does NOT split (verified below): only the semantic parts can separate them. */
const UNSPLIT: Record<string, [string, string, string]> = {
  en: ['Okay, thanks. Is there parking close by, and could you book me in for Monday morning?', 'Is there parking close by', 'could you book me in for Monday morning'],
  sv: ['Vilka öppettider har ni, och kan jag boka tisdag klockan 14?', 'Vilka öppettider har ni', 'kan jag boka tisdag klockan 14'],
  de: ['Gibt es Parkplätze in der Nähe und könnten Sie mich für Montagvormittag eintragen?', 'Gibt es Parkplätze in der Nähe', 'könnten Sie mich für Montagvormittag eintragen'],
  es: ['¿Hay aparcamiento cerca y me podrían dar una cita para el lunes por la mañana?', '¿Hay aparcamiento cerca', 'me podrían dar una cita para el lunes por la mañana'],
  fa: ['پارکینگ نزدیک دارید و می‌شود برای دوشنبه صبح برایم وقت بگذارید؟', 'پارکینگ نزدیک دارید', 'می‌شود برای دوشنبه صبح برایم وقت بگذارید'],
  ar: ['هل يوجد موقف قريب ويمكنكم تسجيلي ليوم الاثنين صباحًا؟', 'هل يوجد موقف قريب', 'يمكنكم تسجيلي ليوم الاثنين صباحًا'],
};
const UNSUPPORTED = /cannot match|kan inte matcha|keiner buchbaren|No puedo asociar|نمی‌توانم «|لا أستطيع مطابقة/u;
const mixedProposal = (m: string, lang: string, info: string, booking: string, affirmative = true) => ({ primaryIntent: 'mixed', secondaryIntents: ['business_information', 'new_booking'],
  confidence: 0.92, requestsMutation: true, asksInformation: true, confirmation: 'none', continuesActiveBooking: false, language: lang, resolvedQuestion: m,
  referencesResolved: false, languageSwitch: false, bookingRequest: { serviceMention: '', affirmative }, mixedParts: { informationSpan: info, bookingSpan: booking, informationQuestion: info },
  evidence: [{ quote: info, intent: 'business_information' }, { quote: booking, intent: 'new_booking' }] });

type Kind = 'mixed' | 'information' | 'booking';
const singleProposal = (m: string, lang: string, kind: 'information' | 'booking', service = '') => ({ primaryIntent: kind === 'booking' ? 'new_booking' : 'business_information',
  secondaryIntents: [], confidence: 0.92, requestsMutation: kind === 'booking', asksInformation: kind !== 'booking', confirmation: 'none', continuesActiveBooking: false,
  language: lang, resolvedQuestion: m, referencesResolved: false, languageSwitch: false, bookingRequest: { serviceMention: service, affirmative: kind === 'booking' }, mixedParts: { informationSpan: '', bookingSpan: '', informationQuestion: '' },
  evidence: [{ quote: m, intent: kind === 'booking' ? 'new_booking' : 'business_information' }] });
/** One message: the knowledge part first (existing mixed phrasing of the knowledge path), then the Booking Engine's reply as its own
 * paragraph. The knowledge part must never contain the booking request (only the information part reached the knowledge path). */
/** OWNER mixed turn: exactly two acknowledged messages: the Booking Engine's own reply (unaltered), then the knowledge reply, which
 * never contains the booking request (only the information part reached the knowledge path). */
function assertSeparate(sent: string[], bookingSpan: string, bookingText: string) {
  assert.equal(sent.length, 2, 'booking reply and knowledge reply, each acknowledged on its own');
  assert.equal(sent[0], bookingText.trim(), "the Booking Engine's own reply, unaltered, sent first");
  assert.ok(!sent[1].replace(/\u200c/gu, ' ').includes(bookingSpan.replace(/\u200c/gu, ' ')), 'the booking request did not reach the knowledge path');
}
async function run(t: any, channel: 'telegram' | 'whatsapp' | 'instagram' | 'messenger', lang: string, mode: 'off' | 'owner', text = MIXED[lang], parts = PARTS[lang], kind: Kind = 'mixed', service = '') {
  b.reset(); const sent: string[] = []; let actions = 0;
  t.mock.method(globalThis, 'fetch', async (i: any, o: any) => { sent.push(String(interceptedIncidentSend(i, o))); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'm' }), { status: 200 }); });
  const original = { ...incidentConfig }; incidentConfig.language = lang;
  const forbidden = async () => { actions++; throw Error('no mutation'); };
  const rt = mode === 'off' ? null : new SemanticRoutingRuntime({ config: readSemanticRoutingConfig({ ODINLINK_SEMANTIC_ROUTING_MODE: 'owner',
    ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '77', ODINLINK_SEMANTIC_ROUTING_OWNER_CONVERSATIONS: `77:${channel}:${RECIPIENT}` }),
    classifier: { classify: async (input: any) => ({ output: kind === 'mixed' ? mixedProposal(input.message, lang, parts[0], parts[1]) : singleProposal(input.message, lang, kind, service) }) } });
  b.configure({ semanticRoutingRuntime: rt as any, semanticLanguageResolver: async () => ({ language: lang, confidence: 1 }), postProcess: async () => {},
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }), knowledgeSearch: async () => [], semanticKnowledgeSearch: async () => [],
    geminiGenerate: async () => ({ text: 'GENERATED' }),
    calendarAdapter: { getCalendarId: () => 's', getEvents: async () => [], checkSlots: async () => [], insertAppointment: forbidden, cancelAppointment: forbidden, updateAppointment: forbidden },
    recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden } as any);
  try { await incidentInbound(b, channel, text, RECIPIENT); } finally { Object.assign(incidentConfig, original); b.reset(); }
  return { sent, actions };
}

for (const lang of Object.keys(MIXED)) for (const channel of ['telegram', 'whatsapp', 'instagram', 'messenger'] as const) test(`mixed ${lang}/${channel}: OWNER acknowledged Booking Engine reply then knowledge reply; OFF unchanged`, async t => {
  const off = await run(t, channel, lang, 'off');
  assert.equal(off.sent.length, 2, 'existing behaviour: booking reply and knowledge reply are separate messages');
  const owner = await run(t, channel, lang, 'owner');
  // Oracle: the Booking Engine's own reply to the booking part alone under the same semantic booking intent (OFF reads some of these
  // phrasings lexically, e.g. "appointment for me" as a service; that legacy gap is asserted separately and left unchanged).
  const alone = await run(t, channel, lang, 'owner', PARTS[lang][1], ['', ''], 'booking');
  assertSeparate(owner.sent, PARTS[lang][1], alone.sent[0]);
  assert.doesNotMatch(owner.sent.join('\n'), UNSUPPORTED, 'no service invented from the customer\'s words');
  assert.doesNotMatch(owner.sent.join('\n'), /\b(confirmed|bekräftad|bestätigt|confirmada)\b/iu, 'no implied booking success');
  assert.equal(off.actions + owner.actions, 0);
});

const { prepareLiteralTurn } = await import('../../conversation-intent-continuity');
for (const lang of Object.keys(UNSPLIT)) for (const channel of ['telegram', 'whatsapp', 'instagram', 'messenger'] as const) test(`semantic split ${lang}/${channel}: lexically unsplittable mixed request -> acknowledged Booking Engine reply + knowledge reply`, async t => {
  const [text, info, booking] = UNSPLIT[lang];
  assert.equal(prepareLiteralTurn(text).kind, 'single', 'the lexical splitter cannot separate this phrasing');
  const owner = await run(t, channel, lang, 'owner', text, [info, booking]);
  // Oracle: the Booking Engine's own reply to the booking part sent alone (semantic booking decision). Where the engine does not claim the
  // clause alone (it falls through to general conversation), the mixed turn must give the existing safe action clarification instead.
  const alone = await run(t, channel, lang, 'owner', booking, ['', ''], 'booking');
  assert.equal(alone.sent.length, 1); assert.notEqual(alone.sent[0], 'GENERATED', 'a semantic booking request enters the Booking Engine');
  assertSeparate(owner.sent, booking, alone.sent[0]);
  assert.equal(owner.actions + alone.actions, 0, 'no booking mutation without the engine\'s own confirmation');
});

// Structured booking intent (Sol): the booking text enters the Booking Engine and no person/pronoun is read as a service.
for (const lang of Object.keys(UNSPLIT)) for (const channel of ['telegram', 'whatsapp', 'instagram', 'messenger'] as const) test(`semantic booking ${lang}/${channel}: standalone booking request enters the Booking Engine; no pronoun service`, async t => {
  const booking = UNSPLIT[lang][2];
  const owner = await run(t, channel, lang, 'owner', booking, ['', ''], 'booking');
  assert.equal(owner.sent.length, 1);
  assert.notEqual(owner.sent[0], 'GENERATED', 'booking flow, not general conversation');
  assert.doesNotMatch(owner.sent[0], UNSUPPORTED, 'no service invented from the customer\'s words');
  assert.doesNotMatch(owner.sent[0], /\b(confirmed|bekräftad|bestätigt|confirmada|booked)\b/iu, 'no booking claim before explicit confirmation');
  assert.equal(owner.actions, 0, 'no mutation');
});
test('semantic booking: a named configured service is used; a named unconfigured service is still refused by the catalog', async t => {
  const named = await run(t, 'telegram', 'en', 'owner', 'Could you book me in for a Video Consultation on Monday morning?', ['', ''], 'booking', 'Video Consultation');
  assert.doesNotMatch(named.sent[0], UNSUPPORTED); assert.notEqual(named.sent[0], 'GENERATED');
  const other = await run(t, 'telegram', 'en', 'owner', 'Could you book me in for a hot stone massage on Monday morning?', ['', ''], 'booking', 'hot stone massage');
  assert.match(other.sent[0], /hot stone massage/u); assert.match(other.sent[0], UNSUPPORTED, 'catalog authority unchanged');
  assert.equal(named.actions + other.actions, 0);
});
test('semantic booking OFF: legacy behaviour unchanged for the same phrasings', async t => {
  const en = await run(t, 'telegram', 'en', 'off', UNSPLIT.en[2]);
  assert.match(en.sent[0], UNSUPPORTED, 'existing OFF behaviour (documented gap) is not altered by this change');
});

// ---------------------------------------------------------------- consent, delivery and continuation (P0)
type Turn = { text: string; proposal?: (m: string) => unknown; delivery?: ('ok' | 'fail' | 'throw')[]; duplicate?: boolean };
/** One conversation without state reset between turns. Each turn may script the classifier output and the channel's per-send outcome. */
async function play(t: any, channel: 'telegram' | 'whatsapp' | 'instagram' | 'messenger', lang: string, mode: 'off' | 'owner', turns: Turn[]) {
  b.reset(); let actions = 0, classifications = 0; let current: Turn = turns[0]; let sendIndex = 0; const perTurn: string[][] = [];
  t.mock.method(globalThis, 'fetch', async (i: any, o: any) => {
    const text = String(interceptedIncidentSend(i, o)); const outcome = current.delivery?.[sendIndex++] ?? 'ok';
    perTurn.at(-1)!.push(`${outcome}:${text}`);
    if (outcome === 'throw') throw new TypeError('network reset');
    if (outcome === 'fail') return new Response(JSON.stringify({ ok: false, error: { code: 131000, message: 'rejected' } }), { status: 500 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'm', messages: [{ id: 'wamid.x' }], contacts: [{ wa_id: RECIPIENT }] }), { status: 200 });
  });
  const original = { ...incidentConfig }; incidentConfig.language = lang;
  const forbidden = async () => { actions++; throw Error('no mutation'); };
  const rt = mode === 'off' ? null : new SemanticRoutingRuntime({ config: readSemanticRoutingConfig({ ODINLINK_SEMANTIC_ROUTING_MODE: 'owner',
    ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '77', ODINLINK_SEMANTIC_ROUTING_OWNER_CONVERSATIONS: `77:${channel}:${RECIPIENT}` }),
    classifier: { classify: async (input: any) => { classifications++; if (!current.proposal) throw new Error('scripted: unavailable'); return { output: current.proposal(input.message) }; } } });
  b.configure({ semanticRoutingRuntime: rt as any, semanticLanguageResolver: async () => ({ language: lang, confidence: 1 }), postProcess: async () => {},
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }), knowledgeSearch: async () => [], semanticKnowledgeSearch: async () => [],
    geminiGenerate: async () => ({ text: 'GENERATED' }),
    calendarAdapter: { getCalendarId: () => 's', getEvents: async () => [], checkSlots: async () => [], insertAppointment: forbidden, cancelAppointment: forbidden, updateAppointment: forbidden },
    recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden } as any);
  const { incidentSession } = await import('../../../../tests/helpers/p0-incident-knowledge');
  const session = incidentSession(b, channel, RECIPIENT);
  try {
    for (const turn of turns) {
      current = turn; sendIndex = 0; perTurn.push([]);
      if (turn.duplicate) await duplicateInbound(channel, turn.text); else await incidentInbound(b, channel, turn.text, RECIPIENT);
    }
    return { perTurn, actions, classifications, history: b.promptAuditHistory(session).map((h: any) => `${h.role}:${h.content}`), pending: b.pendingStateSnapshot(session) };
  } finally { Object.assign(incidentConfig, original); b.reset(); }
}
/** The same provider event delivered twice (webhook retry). */
let dupSerial = 900_000;
async function duplicateInbound(channel: string, text: string) {
  const id = String(++dupSerial), now = Date.now();
  const once = () => channel === 'telegram' ? b.telegramInbound({ update_id: id, message: { chat: { id: RECIPIENT }, text, date: Math.floor(now / 1000) } }, incidentConfig)
    : channel === 'whatsapp' ? b.whatsappInbound({ id, from: RECIPIENT, text: { body: text }, type: 'text', timestamp: String(Math.floor(now / 1000)) }, { phone_number_id: '10001' }, incidentConfig)
    : (channel === 'instagram' ? b.instagramInbound : b.messengerInbound)({ sender: { id: RECIPIENT }, recipient: { id: channel === 'instagram' ? '30001' : '40001' }, timestamp: now, message: { mid: id, text } }, incidentConfig);
  await once(); await once();
}
/** Booking state without wall-clock fields (createdAt/updatedAt/savedAt/expiresAt differ between two runs by milliseconds). */
const stable = (v: any): any => v === null || typeof v !== 'object' ? v : Array.isArray(v) ? v.map(stable)
  : Object.fromEntries(Object.entries(v).filter(([k]) => !/(?:At|Ms)$/u.test(k)).map(([k, x]) => [k, stable(x)]));
const strip = (turns: string[][]) => turns.map(x => x.map(y => y.replace(/^(ok|fail|throw):/u, '')));
const EN_INFO = 'Is there parking close by';
const proposal = (info: string, booking: string, affirmative = true) => (m: string) => mixedProposal(m, 'en', info, booking, affirmative);

for (const channel of ['telegram', 'whatsapp', 'instagram', 'messenger'] as const) {
  test(`consent ${channel}: negated, conditional, overlapping and under-covering mixed parts never drive the booking; full message on the OFF path`, async t => {
    const cases: [string, (m: string) => unknown][] = [
      ["Is there parking close by? Don't book me in for Monday yet.", proposal(EN_INFO, "Don't book me in for Monday yet", false)],              // negation
      ['Is there parking close by? If Monday morning is free, book me in.', proposal(EN_INFO, 'If Monday morning is free, book me in', false)],     // conditional
      ['Is there parking close by, and could you book me in for Monday morning?', proposal('Is there parking close by, and could you', 'could you book me in for Monday morning')], // overlap
      ['Is there parking close by? Book me in for Monday morning, but only with Dr Lind and only before nine.', proposal(EN_INFO, 'Book me in for Monday morning')],             // omitted qualifier
    ];
    for (const [text, p] of cases) {
      const off = await play(t, channel, 'en', 'off', [{ text }]);
      const owner = await play(t, channel, 'en', 'owner', [{ text, proposal: p }]);
      assert.deepEqual(owner.perTurn, off.perTurn, `identical replies to OFF: ${text}`);
      assert.deepEqual(stable(owner.pending), stable(off.pending), `identical booking state to OFF: ${text}`);
      assert.equal(owner.actions + off.actions, 0);
    }
  });

  test(`consent ${channel}: with pending booking state an owner mixed turn answers information without confirming from a fragment`, async t => {
    const start: Turn = { text: 'Jag vill boka en tid tisdag klockan 14.' }; // legacy classification (unavailable) in both runs
    const first = await play(t, channel, 'sv', 'owner', [start]);
    assert.equal(first.pending?.status, 'awaiting_confirmation', 'the first turn offered a slot and awaits explicit confirmation');
    const yes = 'Var finns parkering? Ja, boka den.';
    const pending = await play(t, channel, 'sv', 'owner', [start, {
      text: yes, proposal: m => mixedProposal(m, 'sv', 'Var finns parkering?', 'Ja, boka den.'),
    }]);
    assert.equal(pending.perTurn[1].length, 1, 'only the information reply is sent');
    assert.match(pending.perTurn[1][0], /parkering|bekräfta utifrån|verifiera/iu);
    assert.equal(pending.pending?.status, 'awaiting_confirmation');
    assert.equal(pending.pending?.dateTime, first.pending?.dateTime);
    const continued = await play(t, channel, 'sv', 'owner', [start, {
      text: yes, proposal: m => mixedProposal(m, 'sv', 'Var finns parkering?', 'Ja, boka den.'),
    }, { text: 'Ja tack, boka den.' }]);
    assert.equal(continued.pending?.status, 'awaiting_contact', 'a new full-message confirmation resumes the owned slot');
    assert.equal(continued.pending?.dateTime, first.pending?.dateTime);
    assert.equal(pending.actions + continued.actions, 0, 'no mutation');
  });

  test(`delivery ${channel}: a failed or ambiguous booking reply is never recorded as delivered; the knowledge reply is still sent; booking continues next turn`, async t => {
    const text = 'Okay, thanks. Is there parking close by, and could you book me in for Monday morning?';
    const p = proposal(EN_INFO, 'could you book me in for Monday morning');
    const ok = await play(t, channel, 'en', 'owner', [{ text, proposal: p }]);
    const booking = strip(ok.perTurn)[0][0];
    assert.ok(ok.history.some(h => h.endsWith(booking)), 'acknowledged booking reply is recorded');
    for (const failure of ['fail', 'throw'] as const) {
      const r = await play(t, channel, 'en', 'owner', [{ text, proposal: p, delivery: [failure] }]);
      assert.match(r.perTurn[0][0], new RegExp(`^${failure}:`), 'the booking reply was the first send');
      assert.ok(!r.history.some(h => h.endsWith(booking)), `${failure}: an unacknowledged booking reply is not recorded as delivered`);
      assert.equal(r.perTurn[0].length, 2, `${failure}: the knowledge reply is still sent separately`);
      assert.equal(r.actions, 0);
    }
    // The customer's next short reply continues the booking created by the mixed turn (pending state survives the knowledge clause).
    const cont = await play(t, channel, 'en', 'owner', [{ text, proposal: p }, { text: '11:00' }]);
    assert.ok(cont.pending, 'pending booking survives the knowledge clause');
    const next = strip(cont.perTurn)[1];
    assert.equal(next.length, 1); assert.notEqual(next[0], 'GENERATED', 'the short reply is handled by the Booking Engine');
    assert.match(next[0], /11:00/u, 'the chosen time is taken up'); assert.doesNotMatch(next[0], /\b(confirmed|booked)\b/iu, 'still awaiting explicit confirmation');
    assert.equal(cont.actions, 0);
  });

  test(`idempotency ${channel}: a duplicated mixed event yields one classification and no extra replies`, async t => {
    const text = 'Okay, thanks. Is there parking close by, and could you book me in for Monday morning?';
    const p = proposal(EN_INFO, 'could you book me in for Monday morning');
    const once = await play(t, channel, 'en', 'owner', [{ text, proposal: p }]);
    const twice = await play(t, channel, 'en', 'owner', [{ text, proposal: p, duplicate: true }]);
    assert.deepEqual(strip(twice.perTurn), strip(once.perTurn), 'no duplicate replies');
    assert.equal(twice.classifications, 1, 'one classification');
    assert.equal(twice.actions, 0);
  });
}
