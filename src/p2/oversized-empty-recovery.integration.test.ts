import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService, knowledgeSourceRevision, type KnowledgeSearchMatch, type KnowledgeSource } from '../../knowledge';
import type { SourceLanguage } from '../knowledge/semantic-queries';
import { admitted, readySources } from '../../tests/helpers/admotion-current-inventory';
import { answerEvidence } from '../ai/business-information-answer-plan';
import { accuracyFirstExtractionAllowance, ACCURACY_FIRST_POLICY } from '../ai/knowledge-timing-policy';
import { SOL_REEXTRACTION_MIN_MS } from '../ai/sol-extraction-canary';
import { DisposableNativeKnowledgeDatabase } from '../../tests/helpers/disposable-native-knowledge-db';
import { ScriptedKnowledgeBudgetOwner } from '../../tests/helpers/knowledge-budget-owner';
import { configureKnowledgeBudgetOwner, type KnowledgeSolStage } from '../ai/knowledge-model-policy';
import { generateWithOpenAi } from '../ai/providers/openai';
import type { ResolvedChannelConnection } from '../channels/connections/contracts';
import { safeUnavailableKnowledge } from './knowledge-lifecycle';
import { NativeKnowledgeRuntime, nativeAsyncControls } from './native-knowledge-runtime';

Object.assign(process.env, {
  NODE_ENV: 'test', AI_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-offline',
  ODINLINK_AI_DEFAULT_MODEL: 'gpt-6.1-sol', ODINLINK_EVIDENCE_FIRST_KNOWLEDGE: 'true',
  ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: 'source-exhaustive-v2', ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL: 'v2',
  ODINLINK_GROUNDED_NATURAL_RESPONSES: 'false', ODINLINK_KNOWLEDGE_NATURAL_COMPOSER: 'off',
  ODINLINK_ASYNC_KNOWLEDGE_ADMISSION: 'true', ODINLINK_ASYNC_KNOWLEDGE_ADMISSION_TENANTS: '3',
  ODINLINK_ASYNC_KNOWLEDGE_PROCESSING: 'true', ODINLINK_ASYNC_KNOWLEDGE_DELIVERY: 'true',
  ODINLINK_ASYNC_KNOWLEDGE_PUBLICATION_V2: 'true', ODINLINK_ASYNC_KNOWLEDGE_FIVE_ATTEMPTS: 'false',
  ODINLINK_ASYNC_KNOWLEDGE_EXTENDED_EXECUTION_MS: '75000', ODINLINK_ASYNC_KNOWLEDGE_EXTENDED_TENANTS: '3',
  ODINLINK_SMART_WAITING: 'false', META_APP_ID: '789', META_WHATSAPP_APP_ID: '789',
});
const { executeDurableKnowledgeTask, priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const accounts = { telegram: '123456', whatsapp: '10001', instagram: '30001', messenger: '40001' };
type Channel = keyof typeof accounts;
type Mode = 'ok' | 'ordinary-empty' | 'malformed' | 'refused' | 'truncated' | 'repeat' | 'number' | 'citation' | 'repair-refused' | 'repair-incomplete'
  | 'coverage' | 'verdict' | 'changed' | 'changed-after-hold' | 'denied' | 'time' | 'expired' | 'attempts'
  | 'superseded' | 'wrong-binding' | 'foreign-evidence' | 'wrong-conversation' | 'fenced-after-hold' | 'other-protocol'
  | 'changed-chunk' | 'late-verification';
const oversizedEmpty = { oversized: true, units: [] };
const questionSv = 'Jag ska besöka AdMotion Studio för första gången. Hur tidigt bör jag komma och hur hittar jag till entrén?';
const factsSv = [
  'Förstagångsbesökare rekommenderas att komma cirka 10 minuter före sin bokade tid.',
  'Entrén ligger på innergården.',
  'Porten är märkt Aurora 7.',
  'De blå skyltarna leder till receptionen på andra våningen.',
];
const capturedFacts = [
  { quote: /Kunder som besöker AdMotion Studio för första gången rekommenderas[^.]+\./u,
    text: 'Förstagångsbesökare rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig i lugn och ro.', modality: 'recommended' },
  { quote: /Detta är en rekommendation för förstagångsbesökare[^.]+\./u,
    text: 'Det är en rekommendation för förstagångsbesökare, inte ett obligatoriskt krav eller en sista ankomsttid.', modality: 'descriptive' },
  { quote: /Studions entré ligger på innergården[^.]+\./u,
    text: 'Studions entré ligger på innergården, inte vid huvudingången mot gatan.', modality: 'descriptive' },
  { quote: /Besökare ska använda porten märkt Aurora 7[^.]+\./u,
    text: 'Besökare ska använda porten märkt Aurora 7 och därefter följa de blå skyltarna till receptionen på andra våningen.', modality: 'required' },
];
const cases = [
  ['telegram', 'sv', questionSv, factsSv],
  ['whatsapp', 'en', 'Where can I park my car when visiting AdMotion Studio?', ['Parking is in the courtyard.']],
  ['instagram', 'de', 'Wo kann ich mein Auto parken?', ['Der Parkplatz liegt im Innenhof.']],
  ['messenger', 'es', '¿Dónde puedo aparcar mi coche?', ['El aparcamiento está en el patio.']],
  ['telegram', 'fa', 'کجا می توانم ماشینم را پارک کنم?', ['پارکینگ در حیاط پشت استودیو قرار دارد.']],
  ['whatsapp', 'ar', 'أين يوجد موقف السيارات?', ['يوجد موقف السيارات في الفناء الخلفي للاستوديو.']],
] as const;
// Six synthetic units bound to the captured source text. These are fixture
// propositions, not a transcript of the six units from 20:10.
const sixFirstVisitFacts = [...capturedFacts.slice(0, 3), ...[
  'Besökare ska använda porten märkt Aurora 7.',
  'Besökare ska därefter följa de blå skyltarna till receptionen.',
  'Receptionen ligger på andra våningen.',
].map((text, index) => ({ quote: capturedFacts[3].quote, text, modality: index === 2 ? 'descriptive' : 'required' }))];
type Entry = readonly [Channel, SourceLanguage, string, readonly string[]];
type PartialCase = 'incident' | 'optional' | 'condition' | 'conflict' | 'number' | 'citation' | 'stale' | 'independent' | 'linked'
  | 'compound' | 'compound-after-repair' | 'missing-records' | 'unknown-dependency' | 'linked-condition' | 'affected-unit'
  | 'forged-evidence' | 'inexact-quote' | 'reused-unit-quote' | 'wrong-aspect' | 'incomplete-inventory';
type PartialFixture = { kind: PartialCase; missingFact?: string };
const compoundAspect = 'hur hittar jag till entrén?';
const isCompound = (kind?: PartialCase) => kind === 'compound' || kind === 'compound-after-repair';
const independentCases = [
  { channel: 'telegram', language: 'sv',
    question: 'Jag ska besöka studion för första gången. Var ligger entrén? Var finns parkeringen? Var ligger receptionen? Var finns förvaringsskåpen?',
    facts: ['Entrén ligger på innergården.', 'Parkeringen ligger bakom studion.', 'Receptionen ligger på andra våningen.'],
    missing: 'Förvaringsskåpen finns vid kapprummet.', notice: 'Det fullständiga svaret på ”Var finns förvaringsskåpen?” kan inte bekräftas utifrån den tillgängliga informationen.' },
  { channel: 'whatsapp', language: 'en',
    question: 'I am visiting the studio for the first time. Where is the entrance? Where is the parking? Where is the reception? Where are the lockers?',
    facts: ['The entrance is in the courtyard.', 'Parking is behind the studio.', 'Reception is on the second floor.'],
    missing: 'The lockers are by the cloakroom.', notice: 'The full answer to “Where are the lockers?” cannot be confirmed from the available information.' },
  { channel: 'instagram', language: 'de',
    question: 'Ich besuche AdMotion Studio zum ersten Mal. Wo ist der Eingang? Wo ist der Parkplatz? Wo ist der Empfang? Wo sind die Schließfächer?',
    facts: ['Der Eingang liegt im Innenhof.', 'Der Parkplatz liegt hinter dem Studio.', 'Der Empfang ist im zweiten Stock.'],
    missing: 'Die Schließfächer sind neben der Garderobe.', notice: 'Die vollständige Antwort auf „Wo sind die Schließfächer?“ kann anhand der verfügbaren Informationen nicht bestätigt werden.' },
  { channel: 'messenger', language: 'es',
    question: 'Voy a visitar el estudio por primera vez. ¿Dónde está la entrada? ¿Dónde está el aparcamiento? ¿Dónde está la recepción? ¿Dónde están las taquillas?',
    facts: ['La entrada está en el patio.', 'El aparcamiento está detrás del estudio.', 'La recepción está en la segunda planta.'],
    missing: 'Las taquillas están junto al guardarropa.', notice: 'La respuesta completa a «¿Dónde están las taquillas?» no puede confirmarse con la información disponible.' },
  { channel: 'telegram', language: 'fa',
    question: 'برای اولین بار به استودیو می‌آیم. ورودی کجاست؟ پارکینگ کجاست؟ پذیرش کجاست؟ کمدها کجا هستند؟',
    facts: ['ورودی در حیاط است.', 'پارکینگ پشت استودیو است.', 'پذیرش در طبقه دوم است.'],
    missing: 'کمدها کنار رختکن هستند.', notice: 'پاسخ کامل به «کمدها کجا هستند؟» را نمی‌توان بر اساس اطلاعات موجود تأیید کرد.' },
  { channel: 'whatsapp', language: 'ar',
    question: 'سأزور الاستوديو للمرة الأولى. أين يقع المدخل؟ أين يقع موقف السيارات؟ أين يقع الاستقبال؟ أين توجد الخزائن؟',
    facts: ['يقع المدخل في الفناء.', 'يقع موقف السيارات خلف الاستوديو.', 'يقع الاستقبال في الطابق الثاني.'],
    missing: 'تقع الخزائن بجوار غرفة تبديل الملابس.', notice: 'لا يمكن تأكيد الإجابة الكاملة عن «أين توجد الخزائن؟» من المعلومات المتاحة.' },
] as const;
const config = { id: 3, businessId: 3, businessName: 'AdMotion Studio', timezone: 'Europe/Stockholm',
  channelConnectionId: 'synthetic-connection', telegramToken: '123456:synthetic-offline', telegramBusinessResolved: true,
  whatsappPhoneNumberId: accounts.whatsapp, whatsappAccessToken: 'synthetic-only',
  instagramAccountId: accounts.instagram, instagramAccessToken: 'synthetic-only',
  messengerPageId: accounts.messenger, messengerPageAccessToken: 'synthetic-only', services: [] };

function verifier(data: any, mode: Mode) {
  const complete = mode !== 'coverage', entailed = mode !== 'verdict';
  const accepted = entailed ? data.units.map((u: any) => u.id) : [];
  return {
    decisions: data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation: entailed ? 'ENTAILED' : 'CONTRADICTED',
      meaningPreserved: entailed, modalityPreserved: entailed, qualifiersPreserved: entailed, relevant: true,
      languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
    coverage: data.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: complete,
      incompletenessReason: complete ? 'NONE' : 'MISSING_RELEVANT_FACT', materialUnitIds: accepted,
      obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: complete ? 'COVERED' : 'UNRESOLVED', unitIds: complete ? accepted : [] })) })),
    sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true, availableMaterialFactsComplete: complete,
      conditionsPreserved: true, conflictsAbsent: true, evidenceIdsReviewed: data.evidence.map((e: any) => e.id),
      acceptedUnitIdsReviewed: accepted, obligations: data.facets.flatMap((f: any) => f.obligations.map((o: any) => ({
        facetId: f.id, obligationId: o.id, state: complete ? 'COMPLETE' : 'AVAILABLE_SOURCE_FACT_OMITTED',
      }))) },
  };
}

function partialVerifier(data: any, { kind, missingFact }: PartialFixture) {
  const verdict = verifier(data, 'ok');
  if (kind === 'optional') {
    // The PDF also recommends reading the studio information before visiting.
    // The fixture verifier judges that unrequested advice independent of the
    // requested arrival time and access directions.
    assert.equal(data.units.length, 6);
    assert.ok(data.evidence.some((item: any) => item.text.includes('Vi rekommenderar att alla besökare läser igenom informationen')));
    return { ...verdict, sourceCoverage: { ...verdict.sourceCoverage, omissions: { complete: true, records: [] } } };
  }
  const compound = isCompound(kind);
  const independent = compound || !!missingFact;
  const condition = kind === 'condition';
  const gapFacet = compound || condition ? data.facets[0] : missingFact ? data.facets[3] : undefined;
  const gaps = gapFacet ? [gapFacet.id] : data.facets.map((facet: any) => facet.id);
  const omittedQuotes = compound || condition ? capturedFacts.slice(2, condition ? 3 : undefined).map(fact => {
    const evidence = data.evidence.find((item: any) => fact.quote.test(item.text));
    assert.ok(evidence);
    return evidence.text.match(fact.quote)[0];
  }) : missingFact ? [kind === 'reused-unit-quote' ? data.units[0].evidenceRefs[0].exactQuote : missingFact] : [];
  const omissions = (independent || condition) && kind !== 'missing-records' ? {
    complete: kind !== 'incomplete-inventory',
    records: omittedQuotes.map(exactQuote => ({
      obligationId: gapFacet.obligations[0].id,
      requestedAspect: kind === 'wrong-aspect' ? data.facets[0].obligations[0].description
        : compound || condition ? compoundAspect : gapFacet.obligations[0].description,
      evidenceId: kind === 'forged-evidence' ? 'invented-evidence' : data.evidence.find((e: any) => e.text.includes(exactQuote)).id,
      exactQuote: kind === 'inexact-quote' ? exactQuote + ' Altered.' : exactQuote,
      classification: kind === 'unknown-dependency' ? 'UNKNOWN' : kind === 'linked-condition' || condition ? 'LINKED' : 'INDEPENDENT',
      affectedUnitIds: condition ? [data.units.find((unit: any) => unit.text === 'Studions entré ligger på innergården.').id]
        : kind === 'linked-condition' || kind === 'affected-unit' ? [data.units[0].id] : [],
    })),
  } : undefined;
  const reason = kind === 'condition' ? 'MISSING_CONDITION' : 'MISSING_RELEVANT_FACT';
  if (kind === 'condition') {
    assert.ok(data.evidence.some((item: any) => item.text.includes('inte vid huvudingången mot gatan')));
    assert.ok(data.units.some((unit: any) => unit.text === 'Studions entré ligger på innergården.'));
    assert.ok(data.units.every((unit: any) => !unit.text.includes('huvudingången')));
  }
  return {
    ...verdict,
    coverage: verdict.coverage.map(row => {
      const unitIds = data.units.filter((unit: any) => unit.facetIds.includes(row.facetId)).map((unit: any) => unit.id);
      const gap = gaps.includes(row.facetId);
      return { ...row, materialFactsComplete: !gap, materialUnitIds: unitIds,
        incompletenessReason: gap ? reason : 'NONE',
        obligations: row.obligations.map((obligation: any) => ({ ...obligation,
          status: gap ? 'UNRESOLVED' : 'COVERED', unitIds: gap ? [] : unitIds })) };
    }),
    sourceCoverage: { ...verdict.sourceCoverage, availableMaterialFactsComplete: false, ...(omissions ? { omissions } : {}),
      conditionsPreserved: kind !== 'condition', conflictsAbsent: kind !== 'conflict',
      obligations: verdict.sourceCoverage.obligations.map((row: any) => ({ ...row, state: !gaps.includes(row.facetId) ? 'COMPLETE' :
        independent ? 'INDEPENDENT_REQUESTED_FACT_OMITTED' : kind === 'condition' ? 'MISSING_CONDITION' : 'AVAILABLE_SOURCE_FACT_OMITTED' })),
    },
  };
}

test('managed durable oversized-empty recovery through native intake and PostgreSQL final outbox', async t => {
  const pg = new DisposableNativeKnowledgeDatabase();
  t.after(() => pg.close());
  pg.sql('INSERT INTO public.businesses VALUES (3);');
  pg.sql(readFileSync('docs/designs/durable-knowledge-publication-migration-package/durable-publication-v2.sql', 'utf8'));
  let serial = 10000;
  const captured = readySources();
  const { matches: corpus } = await admitted(captured);
  assert.deepEqual(corpus.map(m => m.text.length), [1800, 258, 1520, 1037, 264]);
  const sqlText = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  pg.sql(`CREATE TABLE public.knowledge_sources(id uuid PRIMARY KEY,business_id bigint,title text,status text);
    CREATE TABLE public.knowledge_chunks(source_id uuid,business_id bigint,chunk_index integer,content text,metadata jsonb,search_vector tsvector);
    GRANT SELECT ON public.knowledge_sources,public.knowledge_chunks TO service_role;`);
  pg.sql(readFileSync('supabase/migrations/20260926112616_improve_knowledge_search_language_relevance.sql', 'utf8'));
  for (const source of captured) {
    pg.sql(`INSERT INTO knowledge_sources VALUES (${sqlText(source.id)},3,${sqlText(source.title)},'ready');`);
    corpus.filter(m => m.sourceId === source.id).forEach((match, index) => {
      const content = sqlText(match.text);
      pg.sql(`INSERT INTO knowledge_chunks VALUES (${sqlText(source.id)},3,${index},${content},
        ${sqlText(JSON.stringify(match.metadata))}::jsonb,to_tsvector('simple',${content}));`);
    });
  }
  function lexical(business: number, query: string, limit: number): KnowledgeSearchMatch[] {
    assert.equal(business, 3);
    const rows = JSON.parse(pg.sql(`SET ROLE service_role;
      SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]') FROM public.search_knowledge_chunks(3,${sqlText(query)},${limit}) t;`));
    return rows.map((row: any) => ({ sourceId: row.source_id, businessId: row.business_id,
      text: row.content, score: row.score, metadata: row.metadata }));
  }

  async function run(st: TestContext, entry: Entry, mode: Mode, variant: 'synthetic' | 'foreground' | 'lexical' = 'synthetic', partial?: PartialFixture) {
    const [channel, language, question, facts] = entry;
    const foreground = variant === 'foreground';
    const fixtureCorpus = variant !== 'synthetic' && !partial?.missingFact;
    const patchExpected = process.env.ODINLINK_PARITY_UNPATCHED !== '1';
    const providerAccount = accounts[channel], recipient = String(46700000000 + ++serial);
    const sourceText = partial?.missingFact ? [facts[0], facts.slice(1).join(' '), partial.missingFact] : [facts.slice(language === 'sv' ? 1 : 0).join(' '), 'Documents describe the studio and visitor services.',
      language === 'sv' ? facts[0] : 'Visit details are available from the studio.'];
    let sources: KnowledgeSource[] = sourceText.map((content, i) => ({
      id: `source-${i}`, businessId: 3, type: 'document', title: `Fixture source ${i}`,
      content, status: 'ready', createdAt: 'synthetic', updatedAt: 'synthetic', metadata: { segments: [{ text: content }] },
    }));
    if (fixtureCorpus) sources = captured;
    const storage = new InMemoryKnowledgeStorage();
    const service = new KnowledgeService(storage, storage, null);
    if (fixtureCorpus) for (const source of sources) await storage.create(source);
    const owner = new ScriptedKnowledgeBudgetOwner();
    owner.businessIds = [3];
    const quotes: KnowledgeSolStage[] = [], calls: KnowledgeSolStage[] = [], posts: string[] = [], failures: string[] = [];
    const reserve = owner.reserve.bind(owner);
    const now = Date.now.bind(Date);
    let taskId: string, conversationId: string;
    const changeSource = () => { sources = sources.map((s, i) => i === 2 ? { ...s, updatedAt: 'updated', content: s.content + ' Updated.' } : s); };
    st.mock.method(owner, 'reserve', async (quote, signal) => {
      quotes.push(quote.stage);
      if (quote.stage === 're_extraction' && mode === 'denied') return null;
      const receipt = await reserve(quote, signal);
      if (quote.stage === 're_extraction' && mode === 'changed-after-hold') changeSource();
      if (quote.stage === 're_extraction' && mode === 'fenced-after-hold')
        pg.sql(`UPDATE odin_tasks SET knowledge_fence = knowledge_fence + 1 WHERE id = '${taskId}';`);
      if (quote.stage === 'verification' && mode === 'late-verification')
        st.mock.method(Date, 'now', () => now() + 11_000);
      return receipt;
    });
    configureKnowledgeBudgetOwner(owner);
    st.after(() => { configureKnowledgeBudgetOwner(); b.reset(); process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL = 'source-exhaustive-v2'; });
    if (mode === 'other-protocol') process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL = 'v2';
    let activeStage: KnowledgeSolStage | undefined;
    const diagnostics: Record<string, unknown>[] = [];
    const summaries: any[] = [], decisions: any[] = [];
    const wires: any[] = [];
    let original: { content: string; schema: unknown } | undefined;
    const response = (body: unknown) => Response.json(body);
    const fetcher: typeof fetch = async (input, options) => {
      const url = new URL(String(input));
      if (url.origin === 'https://api.openai.com') {
        assert.equal(url.pathname, '/v1/responses');
        const stage = activeStage!;
        assert.ok(stage);
        const wire = JSON.parse(String(options?.body));
        const content = wire.input[0].content, data = JSON.parse(content);
        assert.equal(wire.model, 'gpt-6.1-sol');
        assert.equal(wire.max_output_tokens, 8192);
        assert.equal(wire.reasoning.effort, 'low');
        assert.equal(data.question, question.replaceAll('؟', '?').replaceAll('‌', ' '));
        assert.equal(data.requestedLanguage, language);
        assert.equal(data.evidence.length, fixtureCorpus ? 5 : 3);
        assert.ok(data.evidence.every((item: any) => item.businessId === 3));
        const hold = [...owner.reservations.values()].find(r => r.quote.stage === stage);
        assert.ok(quotes.includes(stage) && hold);
        const wireBody = JSON.stringify(wire);
        assert.equal(hold.quote.requestSha256, createHash('sha256').update(wireBody).digest('hex'));
        assert.equal(hold.quote.maximumNanoUsd, (Buffer.byteLength(wireBody) + 2048) * 2500 + 8192 * 10000);
        if (!foreground) assert.equal(Number(pg.sql(`SELECT knowledge_model_attempts FROM odin_tasks WHERE id = '${taskId}';`)) >= calls.length + 1, true);
        calls.push(stage);
        wires.push(wire);
        if (stage === 'extraction') original = { content, schema: wire.text.format };
        if (stage === 're_extraction') {
          assert.deepEqual({ content, schema: wire.text.format }, original);
          assert.match(wire.instructions, /Reassess the whole question/);
        }
        const units = !fixtureCorpus ? facts.map((fact, i) => ({ facetIds: partial?.missingFact
          ? [data.facets[i].id, ...(partial.kind === 'linked' && i === 0 ? [data.facets[3].id] : [])]
          : data.facets.map((f: any) => f.id),
          subject: 'AdMotion Studio', predicate: 'visitor information', value: fact,
          modality: !partial?.missingFact && language === 'sv' && i === 0 ? 'recommended' : 'descriptive', negation: false,
          scope: 'studio visitors', qualifiers: [], language, text: mode === 'number' && i === 0 ? fact.replace('10', '99') : fact,
          evidenceRefs: [{ evidenceId: data.evidence.find((e: any) => e.text.includes(fact))?.id,
            exactQuote: mode === 'citation' && i === 0 ? fact + ' Altered.' : fact }] })) : (isCompound(partial?.kind) ? sixFirstVisitFacts.slice(0, 2) : partial ? sixFirstVisitFacts : capturedFacts).map((fact, index) => {
          const item = data.evidence.find((e: any) => fact.quote.test(e.text));
          assert.ok(item, 'original source wording must appear on the selected wire');
          const quote = item.text.match(fact.quote)[0];
          if (fact.quote === capturedFacts[3].quote) assert.match(quote, /andra\nvåningen/);
          return { facetIds: data.facets.map((f: any) => f.id), subject: 'AdMotion Studio', predicate: 'besöksinformation',
            value: fact.text, modality: fact.modality, negation: false, scope: 'studiobesök', qualifiers: [], language,
            text: partial?.kind === 'number' && index === 0 ? fact.text.replace('10', '99')
              : partial?.kind === 'condition' && index === 2 ? 'Studions entré ligger på innergården.' : fact.text,
            evidenceRefs: [{ evidenceId: item.id, exactQuote: partial?.kind === 'citation' && index === 0 ? quote + ' Ändrat.' : quote }] };
        });
        if (partial?.missingFact) {
          assert.equal(data.facets.length, 4);
          assert.ok(data.evidence.some((item: any) => item.text.includes(partial.missingFact)));
        }
        if (stage === 'verification' && partial?.kind === 'optional') {
          assert.match(wire.instructions, /Unrequested context that cannot affect the answer does not make either completeness flag false/u);
          const schema = wire.text.format.schema.properties.sourceCoverage;
          assert.ok(schema.required.includes('omissions'));
          const records = schema.properties.omissions.properties.records;
          assert.equal(records.maxItems, 6);
          assert.equal(records.items.additionalProperties, false);
          assert.deepEqual(records.items.required, ['obligationId', 'requestedAspect', 'evidenceId', 'exactQuote', 'classification', 'affectedUnitIds']);
          assert.equal(records.items.properties.exactQuote.maxLength, 600);
        }
        const firstPassFixture = partial && partial.kind !== 'compound-after-repair';
        const payload = stage === 'verification' ? partial ? partialVerifier(data, partial) : verifier(data, mode) : firstPassFixture || foreground || stage === 're_extraction' && mode !== 'repeat'
          ? mode === 'repair-incomplete' ? { units } : { oversized: false, units }
          : stage === 'extraction' && mode === 'ordinary-empty' ? { oversized: false, units: [] } : oversizedEmpty;
        const status = stage === 'extraction' && mode === 'truncated' ? 'incomplete' : 'completed';
        const refused = stage === 'extraction' && mode === 'refused' || stage === 're_extraction' && mode === 'repair-refused';
        const output = refused ? { type: 'refusal', refusal: 'fixture' }
          : { type: 'output_text', text: stage === 'extraction' && mode === 'malformed' ? '{broken' : JSON.stringify(payload), annotations: [] };
        if (stage === 'extraction' && mode === 'changed' || stage === 'verification' && partial?.kind === 'stale') changeSource();
        if (stage === 'extraction' && mode === 'changed-chunk') {
          // Change a canonical PDF chunk without varying its length, timestamp or
          // document segment metadata. Strict validation must reject the old pin.
          const pdf = sources[0];
          const changed = { ...pdf, content: pdf.content.replace('Aurora 7', 'Aurora 8') };
          assert.notEqual(changed.content, pdf.content);
          assert.notEqual(knowledgeSourceRevision(changed), knowledgeSourceRevision(pdf));
          sources = [changed, ...sources.slice(1)];
          await storage.create(changed);
        }
        if (stage === 'extraction' && mode === 'superseded') {
          const successor = await runtime.repository.acceptOrdered({ businessId: 3, channel, providerAccount, conversationId },
            'synthetic-successor', { atMs: Math.floor(Date.now() / 1000) * 1000, sequence: serial + 1 });
          assert.equal(successor.disposition, 'ACCEPTED');
        }
        return response({ object: 'response', id: `resp_fixture_${calls.length}`, model: wire.model, status, service_tier: wire.service_tier,
          reasoning: wire.reasoning, prompt_cache_options: wire.prompt_cache_options, output: [{ type: 'message', content: [output] }],
          usage: { input_tokens: 500, output_tokens: 200, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
      }
      assert.ok(['api.telegram.org', 'graph.facebook.com', 'graph.instagram.com'].includes(url.hostname), 'unexpected offline network target');
      if (options?.method === 'POST') {
        const body = JSON.parse(String(options.body));
        assert.equal(String(body.chat_id ?? body.to ?? body.recipient.id), recipient);
        posts.push(body.text?.body ?? body.message?.text ?? body.text);
        if (channel === 'telegram') return response({ ok: true, result: { message_id: 1, chat: { id: Number(recipient) } } });
        if (channel === 'whatsapp') return response({ contacts: [{ wa_id: recipient }], messages: [{ id: 'wamid.synthetic' }] });
        return response({ message_id: 'mid-synthetic', recipient_id: recipient });
      }
      if (url.pathname.endsWith('/getMe')) return response({ ok: true, result: { id: 123456, is_bot: true } });
      if (url.pathname.endsWith('/getChat')) return response({ ok: true, result: { id: Number(recipient), type: 'private' } });
      if (url.pathname.endsWith('/getChatMember')) return response({ ok: true, result: { user: { id: 123456 }, status: 'member' } });
      if (url.pathname.endsWith('/debug_token')) return response({ data: { is_valid: true, app_id: '789', user_id: '60001',
        scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], granular_scopes: [
          { scope: 'whatsapp_business_messaging' }, { scope: 'whatsapp_business_management' }], expires_at: 0, data_access_expires_at: 0 } });
      if (url.pathname === '/v25.0/20001') return response({ id: '20001', owner_business_info: { id: '50001' } });
      if (url.pathname.endsWith('/assigned_users')) return response({ data: [{ id: '60001', tasks: ['MANAGE'] }] });
      if (url.pathname.endsWith('/phone_numbers')) return response({ data: [{ id: providerAccount }] });
      if (channel === 'whatsapp') return response({ id: providerAccount, health_status: { can_send_message: 'AVAILABLE' } });
      if (url.pathname.endsWith('/me')) return response(channel === 'instagram' ? { user_id: providerAccount } : { id: providerAccount });
      if (url.pathname.endsWith('/conversations')) return response({ data: [{ participants: { data: [{ id: providerAccount }, { id: recipient }] }, can_reply: true }] });
      assert.fail('unexpected offline provider request');
    };
    st.mock.method(globalThis, 'fetch', fetcher);
    for (const level of ['log', 'warn', 'error'] as const) st.mock.method(console, level, () => {});
    st.mock.method(console, 'info', (label, body) => {
      if (label === '[EvidenceFirstKnowledge]') summaries.push(JSON.parse(body));
      if (label === '[EvidenceFirstDecision]') decisions.push(JSON.parse(body));
    });
    const connection: ResolvedChannelConnection = {
      id: `connection-${channel}`, businessId: 3, provider: channel, providerAccountId: providerAccount,
      providerConnectionId: channel === 'whatsapp' ? '20001' : null, tokenExpiresAt: null, grantedScopes: channel === 'telegram' ? [] :
        [channel === 'whatsapp' ? 'whatsapp_business_messaging' : channel === 'instagram' ? 'instagram_business_manage_messages' : 'pages_messaging'],
      status: 'connected', connectedAt: null, lastVerifiedAt: null, reconnectRequired: false, displayName: null,
      source: 'self_service', credential: { accessToken: channel === 'telegram' ? config.telegramToken : 'synthetic-only' }, metadata: {},
    };
    const cfg = { ...config, language };
    if (foreground) {
      const saved = ['ODINLINK_ASYNC_KNOWLEDGE_ADMISSION', 'ODINLINK_KNOWLEDGE_TIMING_POLICY', 'ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS']
        .map(key => [key, process.env[key]] as const);
      Object.assign(process.env, { ODINLINK_ASYNC_KNOWLEDGE_ADMISSION: 'false', ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '3' });
      st.after(() => { for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    }
    const runtime = new NativeKnowledgeRuntime({ db: pg.db, secret: 'synthetic-p2-native-secret-at-least-32-bytes', controls: nativeAsyncControls,
      connections: async (tenant, candidate) => tenant === 3 && candidate === channel
        ? mode === 'wrong-binding' && calls.length ? { ...connection, providerAccountId: '999999' } : connection : null,
      sources: { list: async tenant => tenant === 3 ? sources : [] }, fetcher,
      execute: (task, ctx, current) => executeDurableKnowledgeTask(task, ctx,
        mode === 'wrong-conversation' ? { ...cfg, id: 77, businessId: 77 } : cfg, current),
    });
    st.after(() => runtime.stop());
    b.reset();
    b.configure({ nativeKnowledgeRuntime: runtime, offlineAi: true, semanticLanguageResolver: async () => ({ language, confidence: 1 }),
      postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 1000 }),
      knowledgeSourceLanguages: async () => [language], completeKnowledgeCorpus: async () => foreground && fixtureCorpus ? corpus : null,
      knowledgeRetrievalDiagnostic: event => diagnostics.push(event),
      knowledgeSearch: async (business, query, limit) => fixtureCorpus ? lexical(business, query, limit) : sources.map(s => ({ businessId: mode === 'foreign-evidence' ? 77 : 3, sourceId: s.id,
        text: s.content, score: 1, metadata: { source: 'document', documentRevision: knowledgeSourceRevision(s) } })),
      validateKnowledgeMatches: async (id, matches) => fixtureCorpus
        ? service.validateMatches(id, matches, { strictSources: true, captureRevision: true, requireCompleteDocumentContext: true })
        : matches.filter(m => sources.some(s => s.id === m.sourceId &&
        s.businessId === m.businessId && knowledgeSourceRevision(s) === (m.metadata?.documentRevision ?? m.metadata?.sourceRevision))),
      aiGenerate: async request => {
        activeStage = request.knowledgeExecution?.stage;
        assert.ok(activeStage, 'unexpected unmetered model request');
        try { return await generateWithOpenAi(request); }
        catch (error) { failures.push(String(error), String((error as Error).cause ?? '')); throw error; }
      },
    });
    const at = Date.now() - 3000, event = serial;
    const inbound = () => {
      if (channel === 'telegram') return b.telegramInbound({ update_id: event, message: { chat: { id: Number(recipient), type: 'private' }, text: question, date: Math.floor(at / 1000) } }, cfg);
      if (channel === 'whatsapp') return b.whatsappInbound({ id: `event-${event}`, from: recipient, text: { body: question }, type: 'text', timestamp: String(Math.floor(at / 1000)) }, { phone_number_id: providerAccount }, cfg);
      const input = { sender: { id: recipient }, recipient: { id: providerAccount }, timestamp: at, message: { mid: `event-${event}`, text: question } };
      return channel === 'instagram' ? b.instagramInbound(input, cfg) : b.messengerInbound(input, cfg);
    };
    await inbound();
    if (foreground) return { calls, quotes, task: null, outbox: [], posts, failures, unknown: [], diagnostics, wires, summaries, decisions };
    const accepted = JSON.parse(pg.sql('SELECT to_jsonb(t) FROM odin_tasks t ORDER BY created_at DESC LIMIT 1;'));
    taskId = accepted.id;
    conversationId = accepted.conversation_id;
    const task = () => JSON.parse(pg.sql(`SELECT to_jsonb(t) FROM odin_tasks t WHERE id = '${taskId}';`));
    assert.equal(accepted.knowledge_publication_v2, true);
    assert.equal(accepted.knowledge_channel, channel);
    assert.equal(accepted.knowledge_max_models, 4);
    assert.equal(Date.parse(accepted.knowledge_expires_at) - Date.parse(accepted.knowledge_accepted_at), 75_000);
    // Age a fixture only in this disposable cluster. Preserve its 75-second window.
    const ageSeconds = mode === 'time' ? 45 : mode === 'expired' ? 76 : variant === 'lexical' && mode === 'ok' ? 23 : 0;
    if (ageSeconds) pg.sql(`SET session_replication_role = replica;
      UPDATE odin_tasks SET knowledge_expires_at = statement_timestamp() + interval '${75 - ageSeconds} seconds',
      knowledge_accepted_at = statement_timestamp() - interval '${ageSeconds} seconds' WHERE id = '${taskId}';`);
    if (mode === 'attempts') pg.sql(`UPDATE odin_tasks SET knowledge_model_attempts = 2 WHERE id = '${taskId}';`);
    if (mode === 'superseded') await assert.rejects(runtime.tick(), /knowledge_operation_stopped/);
    else await runtime.tick();
    if (mode === 'ok' && (patchExpected || variant === 'synthetic')) {
      await inbound();
      await runtime.tick();
    }
    const outbox = JSON.parse(pg.sql(`SELECT coalesce(jsonb_agg(knowledge_state),'[]'::jsonb) FROM odin_outbox WHERE knowledge_task_id = '${taskId}';`));
    return { calls, quotes, task: task(), outbox, posts, failures, diagnostics, wires, summaries, decisions,
      unknown: [...owner.reservations.values()].filter(r => r.unknown).map(r => r.quote.stage) };
  }

  await t.test('production parity: captured corpus, foreground and durable lexical payloads, one verified final', async st => {
    const foreground = await run(st, cases[0], 'ok', 'foreground');
    assert.deepEqual(foreground.calls, ['extraction', 'verification'], JSON.stringify(foreground.failures));
    assert.equal(foreground.posts.length, 1);
    // The two runs have independent provider owners, recipient bindings and
    // transcripts. Restore the fixture flags before entering the durable lane.
    process.env.ODINLINK_ASYNC_KNOWLEDGE_ADMISSION = 'true';
    delete process.env.ODINLINK_KNOWLEDGE_TIMING_POLICY;
    delete process.env.ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS;
    const durable = await run(st, cases[0], 'ok', 'lexical');
    const patched = process.env.ODINLINK_PARITY_UNPATCHED !== '1';
    assert.deepEqual(durable.calls, patched ? ['extraction', 're_extraction', 'verification'] : ['extraction'], JSON.stringify(durable.failures));
    assert.deepEqual(durable.quotes, durable.calls);
    assert.deepEqual(durable.outbox, ['SENT']);
    assert.equal(durable.posts.length, 1);
    assert.equal(durable.task.knowledge_model_attempts, patched ? 3 : 1);
    assert.equal(durable.task.knowledge_result.protocol, patched ? 'evidence-first-v2' : 'safe-unavailable-v1');
    st.diagnostic(JSON.stringify(durable.wires.map((wire, index) => ({
      stage: durable.calls[index], bytes: Buffer.byteLength(JSON.stringify(wire)),
      maximumNanoUsd: (Buffer.byteLength(JSON.stringify(wire)) + 2048) * 2500 + 8192 * 10000,
    }))));
    const describe = (label: string, result: typeof durable) => {
      const query = result.diagnostics.find(event => event.formattedKnowledgePresent);
      assert.ok(query);
      assert.equal(query.completeCorpusUsed, label === 'foreground');
      assert.equal(query.formattingFailure, null);
      assert.equal(query.matchCount, 5);
      const wire = result.wires[0], data = JSON.parse(wire.input[0].content);
      const ordered = data.evidence.map((item: any) => {
        const chunk = corpus.findIndex(m => m.text === item.text);
        assert.ok(chunk >= 0, 'the entire reconstructed source chunk must reach Sol');
        return { id: item.id, chunk, chars: item.text.length, group: item.sourceGroup };
      });
      assert.equal(new Set(ordered.map((item: { chunk: number }) => item.chunk)).size, corpus.length);
      const sha = (s: string) => createHash('sha256').update(s).digest('hex');
      st.diagnostic(JSON.stringify({ label, completeCorpus: query.completeCorpusUsed, matchCount: query.matchCount,
        lexicalCount: query.lexicalMatchCount, formattedChars: query.formattedKnowledgeLength, serializedChars: query.serializedKnowledgeLength,
        ordered, facets: data.facets, historyCount: data.relevantHistory?.length ?? 0, schema: wire.text.format.name,
        payloadBytes: Buffer.byteLength(wire.input[0].content), wireBytes: Buffer.byteLength(JSON.stringify(wire)),
        requestHash: sha(JSON.stringify(wire)), instructionsHash: sha(wire.instructions) }));
      const selected = ordered.map((item: { chunk: number }) => corpus[item.chunk]);
      return answerEvidence(3, selected);
    };
    const fgEvidence = describe('foreground', foreground);
    const v2Evidence = describe('durable', durable);
    assert.equal(foreground.wires[0].instructions, durable.wires[0].instructions);
    assert.deepEqual(foreground.wires[0].text.format, durable.wires[0].text.format);
    const { evidence: foregroundWireEvidence, ...foregroundInput } = JSON.parse(foreground.wires[0].input[0].content);
    const { evidence: durableWireEvidence, ...durableInput } = JSON.parse(durable.wires[0].input[0].content);
    assert.deepEqual(foregroundInput, durableInput);
    assert.notDeepEqual(foregroundWireEvidence, durableWireEvidence);
    assert.notDeepEqual(fgEvidence.map(e => e.chunkId), v2Evidence.map(e => e.chunkId));
    assert.deepEqual(fgEvidence.map(e => [e.sourceId, e.version, e.chunkId]).sort(),
      v2Evidence.map(e => [e.sourceId, e.version, e.chunkId]).sort());
    for (const fact of capturedFacts) {
      assert.ok(foreground.posts[0].includes(fact.text), fact.text);
      if (patched) assert.ok(durable.posts[0].includes(fact.text), fact.text);
    }
    if (patched) assert.deepEqual(durable.task.knowledge_result.sources.map((pin: any) => [pin.id, pin.revision]).sort(),
      captured.map(source => [source.id, knowledgeSourceRevision(source)]).sort());
    else assert.equal(durable.posts[0], safeUnavailableKnowledge('sv').text);
  });
  await t.test('production parity: repeated oversized on the captured corpus produces one safe final', async st => {
    const result = await run(st, cases[0], 'repeat', 'lexical');
    assert.deepEqual(result.calls, process.env.ODINLINK_PARITY_UNPATCHED === '1' ? ['extraction'] : ['extraction', 're_extraction']);
    assert.deepEqual(result.quotes, result.calls);
    assert.deepEqual(result.posts, [safeUnavailableKnowledge('sv').text]);
    assert.deepEqual(result.outbox, ['SENT']);
  });
  for (const mode of ['changed-chunk', 'time'] as const) await t.test(`production parity: ${mode} blocks repair on the captured corpus`, async st => {
    const result = await run(st, cases[0], mode, 'lexical');
    assert.deepEqual(result.calls, ['extraction']);
    assert.deepEqual(result.quotes, result.calls);
    assert.deepEqual(result.posts, [safeUnavailableKnowledge('sv').text]);
    assert.deepEqual(result.outbox, ['SENT']);
    if (process.env.ODINLINK_PARITY_UNPATCHED !== '1') {
      const repair = result.summaries.find(event => event.reExtraction)?.reExtraction;
      assert.equal(repair?.trigger, 'oversized_empty');
      assert.equal(repair?.outcome, mode === 'time' ? 'skipped' : 'source_changed');
      if (mode === 'time') assert.equal(repair.skipReason, 'deadline');
    }
  });
  await t.test('production parity: verifier allowance lost after hold suppresses provider dispatch and publishes safe final', async st => {
    const result = await run(st, cases[0], 'late-verification', 'lexical');
    const patched = process.env.ODINLINK_PARITY_UNPATCHED !== '1';
    assert.deepEqual(result.calls, patched ? ['extraction', 're_extraction'] : ['extraction']);
    assert.deepEqual(result.quotes, patched ? ['extraction', 're_extraction', 'verification'] : ['extraction']);
    assert.deepEqual(result.unknown, patched ? ['verification'] : []);
    if (patched) assert.ok(result.failures.some(error => error.includes('knowledge_sol_dispatch_allowance')), JSON.stringify(result.failures));
    assert.deepEqual(result.outbox, ['SENT']);
    assert.deepEqual(result.posts, [safeUnavailableKnowledge('sv').text]);
  });
  if (process.env.ODINLINK_PARITY_ONLY === '1') return;

  for (const kind of ['incident', 'optional', 'condition', 'conflict', 'number', 'citation'] as const) {
    await t.test(`Swedish incident fixture: ${kind}`, async st => {
      const result = await run(st, cases[0], 'ok', 'foreground', { kind });
      assert.deepEqual(result.failures, []);
      assert.equal(result.posts.length, 1);
      assert.equal(result.posts[0].includes('Aurora 7'), kind === 'optional');
      if (kind === 'optional') {
        assert.deepEqual(result.calls, ['extraction', 'verification']);
        for (const fact of sixFirstVisitFacts) assert.ok(result.posts[0].includes(fact.text));
        assert.equal(result.summaries[0]?.semanticVerifiedUnits, 6);
        assert.ok(!result.posts[0].includes('läser igenom informationen'));
      }
      const reason = { incident: 'AVAILABLE_FACTS_INCOMPLETE', condition: 'CONDITIONS_NOT_PRESERVED', conflict: 'CONFLICTS_PRESENT' } as const;
      if (kind === 'incident' || kind === 'condition' || kind === 'conflict') {
        assert.equal(result.summaries[0]?.semanticVerifiedUnits, 6);
        const rejection = result.decisions.find(event => event.reason === 'INVALID_COVERAGE');
        assert.equal(rejection?.sourceCoverage.guard, 'GUARD_04');
        assert.deepEqual(rejection.sourceCoverage.failedChecks, kind === 'incident'
          ? [reason.incident] : [reason.incident, reason[kind]]);
      }
      if (kind === 'incident') {
        assert.deepEqual(result.calls, ['extraction', 'verification']);
        assert.deepEqual(result.quotes, result.calls);
        for (const fact of sixFirstVisitFacts) assert.ok(!result.posts[0].includes(fact.text), fact.text);
        assert.ok(!result.decisions.some(event => event.reason === 'SOURCE_COVERAGE_ACCEPTED'));
        const publication = result.decisions.filter(event => event.eventType === 'publication' && event.route);
        assert.ok(publication.length > 0);
        assert.ok(publication.every(event => event.route === 'unavailable' && event.publishableUnits === 0));
      }
      if (kind === 'number' || kind === 'citation') {
        assert.deepEqual(result.calls, ['extraction']);
        assert.ok(!result.posts[0].includes('99'));
      }
    });
  }

  await t.test('Swedish compound: an independent source-bound omission qualifies the arrival recommendation', async st => {
    const result = await run(st, cases[0], 'ok', 'foreground', { kind: 'compound' });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.calls, ['extraction', 'verification']);
    assert.deepEqual(result.quotes, result.calls);
    assert.equal(result.posts.length, 1);
    for (const fact of sixFirstVisitFacts.slice(0, 2)) assert.ok(result.posts[0].includes(fact.text), result.posts[0]);
    assert.match(result.posts[0], /Det fullständiga svaret på ”hur hittar jag till entrén\?” kan inte bekräftas/u);
    assert.ok(!result.posts[0].includes('Aurora 7'));
    const accepted = result.decisions.find(event => event.reason === 'SOURCE_COVERAGE_ACCEPTED');
    assert.equal(accepted?.sourceCoverage.state, 'SCOPED_PARTIAL');
    assert.equal(accepted?.sourceCoverage.guard, 'NONE');
    assert.ok(!JSON.stringify(accepted.sourceCoverage).includes(compoundAspect), 'the decision record remains content-free');
    assert.ok(!JSON.stringify(accepted.sourceCoverage).includes('Aurora 7'));
  });

  await t.test('durable oversized-empty recovery still vetoes an otherwise certified partial', async st => {
    const result = await run(st, cases[0], 'ok', 'lexical', { kind: 'compound-after-repair' });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.calls, ['extraction', 're_extraction', 'verification']);
    assert.deepEqual(result.quotes, result.calls);
    assert.deepEqual(result.posts, [safeUnavailableKnowledge('sv').text]);
    assert.deepEqual(result.outbox, ['SENT']);
    assert.equal(result.task.knowledge_result.protocol, 'safe-unavailable-v1');
  });

  for (const row of independentCases) {
    for (const host of ['foreground', 'durable'] as const) await t.test(`${host}/${row.channel}/${row.language}: publish three answers and acknowledge the fourth`, async st => {
      const entry: Entry = [row.channel, row.language, row.question, row.facts];
      const result = await run(st, entry, 'ok', host === 'foreground' ? 'foreground' : 'synthetic',
        { kind: 'independent', missingFact: row.missing });
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.calls, ['extraction', 'verification'], JSON.stringify({ posts: result.posts, decisions: result.decisions }));
      assert.deepEqual(result.quotes, result.calls);
      assert.equal(result.posts.length, 1);
      for (const fact of row.facts) assert.ok(result.posts[0].includes(fact), fact);
      assert.ok(result.posts[0].includes(row.notice), result.posts[0]);
      assert.ok(!result.posts[0].includes(row.missing));
      const accepted = result.decisions.find(event => event.reason === 'SOURCE_COVERAGE_ACCEPTED');
      assert.equal(accepted?.sourceCoverage.state, 'SCOPED_PARTIAL');
      assert.equal(accepted?.sourceCoverage.guard, 'NONE');
      assert.deepEqual(result.outbox, host === 'durable' ? ['SENT'] : []);
      if (host === 'durable') {
        assert.equal(result.task.knowledge_result.protocol, 'evidence-first-partial-v1');
        assert.equal(result.task.knowledge_result.completeRequiredFacts, false);
        assert.equal(result.task.knowledge_result.independentlyVerified, true);
      }
    });
  }

  for (const kind of ['linked', 'stale', 'missing-records', 'unknown-dependency', 'linked-condition',
    'affected-unit', 'forged-evidence', 'inexact-quote', 'reused-unit-quote', 'wrong-aspect', 'incomplete-inventory'] as const) {
    await t.test(`durable scoped omission stays closed when ${kind}`, async st => {
      const { channel, language, question, facts, missing } = independentCases[1];
      const result = await run(st, [channel, language, question, facts], 'ok', 'synthetic', { kind, missingFact: missing });
      assert.deepEqual(result.calls, ['extraction', 'verification']);
      assert.deepEqual(result.posts, [safeUnavailableKnowledge(language).text]);
      assert.deepEqual(result.outbox, ['SENT']);
      assert.deepEqual(result.quotes, result.calls);
      assert.equal(result.task.knowledge_result.protocol, 'safe-unavailable-v1');
      if (kind !== 'stale') {
        const rejected = result.decisions.find(event => event.reason === 'INVALID_COVERAGE');
        assert.equal(rejected?.sourceCoverage.guard, kind === 'linked' ? 'GUARD_11' : 'GUARD_04');
      }
    });
  }

  for (const entry of cases) await t.test(`${entry[0]}/${entry[1]} verifies exactly once after one repair`, async st => {
    const runResult = await run(st, entry, 'ok');
    assert.deepEqual(runResult.calls, ['extraction', 're_extraction', 'verification'], JSON.stringify(runResult));
    assert.deepEqual(runResult.quotes, runResult.calls);
    assert.equal(runResult.task.knowledge_model_attempts, 3);
    assert.equal(runResult.task.knowledge_result.protocol, 'evidence-first-v2');
    assert.deepEqual(runResult.outbox, ['SENT']);
    assert.equal(runResult.posts.length, 1);
    for (const fact of entry[3]) assert.ok(runResult.posts[0].includes(fact));
  });

  const oneCall = ['ordinary-empty', 'malformed', 'refused', 'truncated', 'changed', 'changed-after-hold',
    'denied', 'time', 'attempts', 'superseded', 'wrong-binding', 'fenced-after-hold', 'other-protocol'] as const;
  const twoCalls = ['repeat', 'number', 'citation', 'repair-refused', 'repair-incomplete'] as const;
  const threeCalls = ['coverage', 'verdict'] as const;
  const noCalls = ['expired', 'foreign-evidence', 'wrong-conversation'] as const;
  for (const [modes, expected] of [[oneCall, ['extraction']], [twoCalls, ['extraction', 're_extraction']],
    [threeCalls, ['extraction', 're_extraction', 'verification']], [noCalls, []]] as const) {
    for (const mode of modes) await t.test(`${mode} cannot publish a factual result or dispatch an extra call`, async st => {
      const result = await run(st, cases[0], mode);
      assert.deepEqual(result.calls, expected, JSON.stringify(result));
      assert.ok(result.posts.every(text => text === safeUnavailableKnowledge('sv').text));
      assert.ok(result.posts.length <= 1 && result.outbox.length <= 1);
      if (['expired', 'superseded', 'wrong-binding', 'fenced-after-hold'].includes(mode)) assert.equal(result.posts.length, 0);
      else assert.deepEqual(result.outbox, ['SENT']);
      if (['denied', 'changed-after-hold', 'fenced-after-hold'].includes(mode)) assert.deepEqual(result.quotes, ['extraction', 're_extraction']);
      else assert.deepEqual(result.quotes, result.calls);
      assert.deepEqual(result.unknown, ['changed-after-hold', 'fenced-after-hold'].includes(mode) ? ['re_extraction'] : []);
    });
  }
});

test('production parity: repair allocation leaves the existing independent-verifier reserve', () => {
  const { extractionMs, verificationReserveMs, verificationDispatchMs, verificationMs } = ACCURACY_FIRST_POLICY;
  assert.deepEqual([extractionMs, verificationReserveMs, verificationDispatchMs, verificationMs], [20_000, 12_000, 10_000, 19_999]);
  for (const generationMs of [0, 11_999, 12_000, 19_999, 20_000, 30_500, 36_370, 58_500]) {
    const repairMs = accuracyFirstExtractionAllowance(generationMs);
    assert.ok(repairMs <= extractionMs);
    if (repairMs >= SOL_REEXTRACTION_MIN_MS) assert.ok(generationMs - repairMs >= verificationReserveMs);
  }
  assert.equal(accuracyFirstExtractionAllowance(19_999), 7_999);
  assert.equal(accuracyFirstExtractionAllowance(20_000), 8_000);
});
