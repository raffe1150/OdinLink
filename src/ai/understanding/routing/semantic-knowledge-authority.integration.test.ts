/** Semantic Knowledge admission and configured-policy authority (release-blocker corrections). SCRIPTED decisions; no provider calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentConfig } from '../../../../tests/helpers/p0-incident-knowledge';
Object.assign(process.env, { NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', AI_PROVIDER: 'gemini', ODINLINK_EVIDENCE_FIRST_KNOWLEDGE: 'true',
  ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '77' });
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../../../server');

const admit = (interpretation?: string) => ({ lane: 'knowledge', knowledge: 'admit', preserveBookingState: true, order: ['knowledge'], reason: 'information',
  ...(interpretation ? { interpretation } : {}) }) as any;
const configWithPolicy = { ...incidentConfig, allowCancellation: true, cancellationDeadlineHours: 48, cancellationFeeAmount: 300, cancellationFeeCurrency: 'SEK' };

test('resolved short follow-ups and language switches reach the durable Knowledge hand-off under an applied semantic decision; OFF unchanged', () => {
  const followUps = ['And who should I let know about that?', 'Och vem ska jag säga till?', 'Und wem sage ich Bescheid?', '¿Y a quién aviso?', 'به چه کسی خبر بدهم؟', 'ومن أبلغ؟',
    'Sorry, my German is bad. Can I bring that too?'];
  for (const q of followUps) assert.equal(b.inspectDurableHandoffEligibilityForTest(q, incidentConfig, admit(`Resolved: ${q}`)), true, `semantic: ${q}`);
  // An applied semantic DENY (booking / clarify / general lane) never reaches Knowledge, even where the lexical predicate alone would admit.
  for (const q of ['And who should I let know about that?', 'Is that one?'])
    assert.equal(b.inspectDurableHandoffEligibilityForTest(q, incidentConfig, { ...admit(), knowledge: 'deny', lane: 'clarify' }), false, q);
  // The configured catalog exclusion stays authoritative even under a semantic admit.
  assert.equal(b.inspectDurableHandoffEligibilityForTest('Which services do you offer?', incidentConfig, admit()), false);
});

test('configured-policy authority: cancellation, configured catalog/prices and opening hours never go to the Reference Engine (configuration wins over documents)', () => {
  const policy = ['What happens if I cancel my appointment the same day?', 'Vad kostar det att avboka sent?', 'Kann ich kostenlos stornieren?', '¿Puedo cancelar mi cita gratis?',
    'لغو نوبت هزینه دارد؟', 'هل يمكنني إلغاء الموعد مجانًا؟', 'Was kostet ein Termin bei Ihnen?', 'How much does a Video Consultation cost?',
    'Vilka öppettider har ni?', '¿Qué horario tienen?', 'Which services do you offer?', 'How long is a Video Consultation?'];
  for (const q of policy) assert.equal(b.configuredPolicyQuestionForTest(q, configWithPolicy), true, q);
  // The genuine Stage A–D Knowledge questions answered by the Reference Engine stay eligible (documents are their authority).
  const knowledge = ['Hej! Jag ska till er för första gången nästa vecka. Hur hittar jag in, och måste jag vara där i god tid?', 'Finns det hiss dit upp?',
    "If I'm stuck in traffic and end up about 20 minutes late, what happens to my appointment?", 'Is there parking close by',
    'Darf ich meine Freundin mitbringen, und kann sie mit ins Behandlungszimmer?', "Can I bring my own water bottle?",
    'Ayer estuve en el estudio y creo que me olvidé un paraguas. ¿Qué hacen con las cosas que se quedan allí?', '¿Y me lo podrían mandar a casa?',
    'من با ویلچر می‌آیم. ساختمان شما برای من قابل دسترسی است؟', 'سرویس بهداشتی هم دارید که بتوانم از آن استفاده کنم؟',
    'هل يمكنني أن آكل شيئًا أثناء الانتظار، وهل هناك ما يجب أن أتجنبه قبل الموعد؟', 'سأحضر ابنتي البالغة من العمر تسع سنوات. هل يمكنني تركها وحدها في غرفة الانتظار أثناء الجلسة؟'];
  const misrouted = knowledge.filter(q => b.configuredPolicyQuestionForTest(q, configWithPolicy));
  assert.deepEqual(misrouted, [], 'document questions keep the Reference path');
});
