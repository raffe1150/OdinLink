/** Production path of the INFORMATION clause of an owner mixed turn (native intake, durable Knowledge enabled).
 * The booking clause is answered first through the channel's acknowledged send; the information clause (Sol's information span only,
 * never the booking words) is ATTACHED to the durable Knowledge task of the same inbound message, whose executor is the Reference
 * Knowledge Engine (Sol answer + independent Sol verifier) for the authorized pilot conversation. No foreground legacy knowledge
 * answer is produced for the clause. SCRIPTED classifier and a recording durable runtime: mechanics only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentConfig, incidentInbound, interceptedIncidentSend } from '../../../../tests/helpers/p0-incident-knowledge';
Object.assign(process.env, { NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', AI_PROVIDER: 'gemini', ODINLINK_EVIDENCE_FIRST_KNOWLEDGE: 'true',
  ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '77', ODINLINK_SMART_WAITING: 'false' });
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../../../server');
const { SemanticRoutingRuntime, readSemanticRoutingConfig } = await import('./runtime');
const { referenceEngineConfig, referenceEngineSelected } = await import('../../../p2/reference-knowledge-executor');

const R = '46700000001';
const TEXT = 'Var finns parkering? Boka en tid åt mig.', INFO = 'Var finns parkering?', BOOK = 'Boka en tid åt mig.';
const mixed = (m: string) => ({ primaryIntent: 'mixed', secondaryIntents: ['business_information', 'new_booking'], confidence: 0.92, requestsMutation: true,
  asksInformation: true, confirmation: 'none', continuesActiveBooking: false, language: 'sv', resolvedQuestion: m, referencesResolved: false, languageSwitch: false,
  bookingRequest: { serviceMention: '', affirmative: true }, mixedParts: { informationSpan: INFO, bookingSpan: BOOK, informationQuestion: INFO },
  evidence: [{ quote: INFO, intent: 'business_information' }, { quote: BOOK, intent: 'new_booking' }] });

for (const channel of ['telegram', 'whatsapp', 'instagram', 'messenger'] as const)
  test(`mixed ${channel}: the information clause is attached to the durable (Reference) task; the booking reply is acknowledged on its own`, async (t) => {
    b.reset(); const sent: string[] = []; const attached: any[] = []; let actions = 0, generated = 0;
    t.mock.method(globalThis, 'fetch', async (i: any, o: any) => { sent.push(String(interceptedIncidentSend(i, o)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'm', messages: [{ id: 'wamid.x' }] }), { status: 200 }); });
    const scope = { businessId: 77, channel, providerAccount: 'acct', conversationId: '6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5' };
    const runtime = { admissionEnabled: false, admissionEnabledFor: () => false,
      accept: async (i: any) => ({ scope, eventId: i.eventId, order: null, result: { disposition: 'ACCEPTED', mayAttach: true, acceptance: { identity: { turnId: 'turn-1' } } } }),
      history: async (_a: any, h: any) => h, attach: async (admission: any, input: any) => { attached.push({ admission, input }); return { attached: true }; } };
    const forbidden = async () => { actions++; throw Error('no mutation'); };
    const original = { ...incidentConfig }; incidentConfig.language = 'sv';
    b.configure({ nativeKnowledgeRuntime: runtime as any,
      semanticRoutingRuntime: new SemanticRoutingRuntime({ config: readSemanticRoutingConfig({ ODINLINK_SEMANTIC_ROUTING_MODE: 'owner',
        ODINLINK_SEMANTIC_ROUTING_BUSINESS_IDS: '77', ODINLINK_SEMANTIC_ROUTING_OWNER_CONVERSATIONS: `77:${channel}:${R}` }),
        classifier: { classify: async (input: any) => ({ output: mixed(input.message) }) } }) as any,
      semanticLanguageResolver: async () => ({ language: 'sv', confidence: 1 }), postProcess: async () => {},
      incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }), knowledgeSearch: async () => [], semanticKnowledgeSearch: async () => [],
      geminiGenerate: async () => { generated++; return { text: 'GENERATED' }; },
      calendarAdapter: { getCalendarId: () => 's', getEvents: async () => [], checkSlots: async () => [], insertAppointment: forbidden, cancelAppointment: forbidden, updateAppointment: forbidden },
      recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden } as any);
    try { await incidentInbound(b, channel, TEXT, R); } finally { Object.assign(incidentConfig, original); b.reset(); }

    assert.equal(attached.length, 1, 'exactly one durable attachment for the message');
    assert.equal(attached[0].input.question, INFO, "Sol's information span only");
    assert.ok(!attached[0].input.question.includes(BOOK), 'the booking words never reach Knowledge');
    assert.equal(sent.length, 1, 'only the Booking Engine reply is sent now; the durable task owns the information reply');
    assert.ok(!sent[0].includes('parkering'), 'no foreground knowledge answer');
    assert.equal(generated, 0, 'no foreground model generation for the information clause');
    assert.equal(actions, 0);
    // The durable executor selects the Reference Knowledge Engine for this task in the authorized owner configuration.
    const task: any = { scope, eventId: attached[0].admission.eventId, input: attached[0].input };
    const owner = referenceEngineConfig({ ODINLINK_KNOWLEDGE_REFERENCE_ENGINE: 'owner', ODINLINK_KNOWLEDGE_REFERENCE_TENANTS: '77',
      ODINLINK_KNOWLEDGE_REFERENCE_OWNER_CONVERSATIONS: `77:${channel}:${scope.conversationId}` });
    assert.equal(referenceEngineSelected(task, owner), true);
    assert.equal(referenceEngineSelected(task, referenceEngineConfig({})), false, 'flags off: the existing durable engine');
  });
