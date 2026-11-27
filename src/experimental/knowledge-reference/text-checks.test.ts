/** EXPERIMENTAL — unit tests for the deterministic text checks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { languageEvidence, languagePlausible, normalizeText, numbersIn, quoteOccursIn } from './text-checks';

test('quotes match across PDF line breaks and digit scripts, but not across paraphrase', () => {
  const content = 'Kunder som besöker studion för första gången rekommenderas att komma cirka 10 minuter före sin\nbokade tid.';
  assert.ok(quoteOccursIn('rekommenderas att komma cirka 10 minuter före sin bokade tid', content));
  assert.ok(quoteOccursIn('cirka ۱۰ minuter före sin bokade', content));
  assert.ok(!quoteOccursIn('rekommenderas att komma ungefär 10 minuter före', content));
  assert.ok(!quoteOccursIn('', content));
});

test('numbers: digits in every script and unambiguous words; ambiguous words only count on the source side', () => {
  assert.deepEqual([...numbersIn('cirka ۱۰ دقیقه', ['fa'])], [10]);
  assert.deepEqual([...numbersIn('حوالي ١٠ دقائق', ['ar'])], [10]);
  assert.deepEqual([...numbersIn('about ten minutes', ['en'])], [10]);
  assert.deepEqual([...numbersIn('ungefär fem minuter', ['sv'])], [5]);
  assert.deepEqual([...numbersIn('عشر دقائق', ['ar'])], [10]);
  assert.deepEqual([...numbersIn('andra besökare', ['sv'])], []);
  assert.ok(numbersIn('receptionen på andra våningen', ['sv'], true).has(2));
  assert.ok(numbersIn('upp till 21 dagar', ['sv']).has(21));
  assert.deepEqual([...numbersIn('Stjärngatan 14', ['sv'])], [14]);
});

test('language plausibility for the six languages (proper names tolerated)', () => {
  const ok: [string, any][] = [
    ['Entrén ligger på innergården och du ska följa de blå skyltarna till receptionen.', 'sv'],
    ['The entrance is in the courtyard and you should follow the blue signs to reception.', 'en'],
    ['Der Eingang ist im Innenhof und Sie sollten den blauen Schildern zur Rezeption folgen.', 'de'],
    ['La entrada está en el patio y debe seguir las señales azules hasta la recepción.', 'es'],
    ['ورودی در حیاط داخلی است و باید تابلوهای آبی را تا پذیرش دنبال کنید. از در Aurora 7 استفاده کنید.', 'fa'],
    ['المدخل في الفناء الداخلي ويجب اتباع اللافتات الزرقاء حتى الاستقبال. استخدم بوابة Aurora 7.', 'ar'],
  ];
  for (const [text, l] of ok) assert.ok(languagePlausible(text, l), `${l} rejected`);
  assert.ok(!languagePlausible(ok[1][0], 'sv'));
  assert.ok(!languagePlausible(ok[0][0], 'de'));
  assert.ok(!languagePlausible(ok[4][0], 'ar'));
  assert.ok(!languagePlausible(ok[5][0], 'fa'));
  assert.ok(!languagePlausible(ok[1][0], 'fa'));
});

test('normalization strips bidi controls but keeps Persian ZWNJ', () => {
  assert.equal(normalizeText('‫می‌توانید‬'), 'می‌توانید');
});

import { protectContent, disclosesProtected, fold, REDACTION } from './secrets';
test('secret protection: secret sentences and credential-shaped tokens are redacted; ordinary words are not', () => {
  const wrapped = protectContent('Öppet för alla.\nDen hemliga testkoden för detta\nföretag är BLÅ-RÄV-742. Välkommen!');
  assert.equal(wrapped.modelContent, `Öppet för alla.\n${REDACTION} Välkommen!`);
  assert.deepEqual([...wrapped.tokens], ['BLARAV742']);
  const key = protectContent('Nyckel: sk-proj_ABCDEFGHIJKLMNOPQRSTUV123 används.');
  assert.ok(!key.modelContent.includes('sk-proj'));
  for (const harmless of ['الخدمة سريعة جداً.', 'Bokningen sker i förväg.', 'The secretary will greet you.'.replace('secretary', 'receptionist')])
    assert.equal(protectContent(harmless).modelContent, harmless);
  assert.ok(disclosesProtected('koden: b l å – r ä v ۷۴۲', [fold('BLÅ-RÄV-742')]));
  assert.ok(!disclosesProtected('Använd porten märkt Aurora 7.', [fold('BLÅ-RÄV-742')]));
});

// ---- 2026-11-25 Pilot 5 sv-08 regression: short valid sentences without function words must not be rejected ----
test('short valid sentences in all six languages are never rejected (genuine sv-08 sentence included)', () => {
  const valid: [string, any][] = [
    ['Vi tar emot kunder efter överenskommelse.', 'sv'], // GENUINE Pilot 5 sv-08 u1, previously UNIT_LANGUAGE_MISMATCH
    ['Mötesinformation skickas efter bekräftad bokning.', 'sv'],
    ['Customers are welcome by appointment.', 'en'],
    ['Meeting details follow after booking confirmation.', 'en'],
    ['Termine werden nach Vereinbarung vergeben.', 'de'],
    ['Kunden werden nach Vereinbarung empfangen.', 'de'],
    ['Atendemos a clientes con cita previa.', 'es'],
    ['Recibimos clientes previa cita.', 'es'],
    ['ما مشتریان را با هماهنگی قبلی می‌پذیریم.', 'fa'],
    ['پذیرش فقط با وقت قبلی است.', 'fa'],
    ['نستقبل العملاء بموعد مسبق.', 'ar'],
    ['يتم إرسال تفاصيل الاجتماع بعد تأكيد الحجز.', 'ar'],
  ];
  for (const [text, l] of valid) {
    assert.ok(languagePlausible(text, l), `${l}: "${text}" rejected (${languageEvidence(text, l)})`);
    assert.notEqual(languageEvidence(text, l), 'wrong_script');
    assert.notEqual(languageEvidence(text, l), 'other_language');
  }
  // The genuine sentence is uncertain, not consistent: the binding verifier verdict decides it.
  assert.equal(languageEvidence('Vi tar emot kunder efter överenskommelse.', 'sv'), 'uncertain');
});

test('wrong-language detection is preserved: objective script errors and positive other-language evidence are rejected', () => {
  const wrong: [string, any, string][] = [
    ['If this is your first visit, you should arrive about 10 minutes before your time.', 'sv', 'other_language'],
    ['Wenn Sie zum ersten Mal kommen, sollten Sie zehn Minuten vor dem Termin da sein.', 'en', 'other_language'],
    ['Om det är ditt första besök bör du komma tio minuter före din tid.', 'de', 'other_language'],
    ['Si es su primera visita, debe llegar unos diez minutos antes de la cita.', 'sv', 'other_language'],
    ['The entrance is in the courtyard and you should follow the signs.', 'es', 'other_language'],
    ['ما مشتریان را با هماهنگی قبلی می‌پذیریم.', 'sv', 'wrong_script'],
    ['نستقبل العملاء بموعد مسبق.', 'en', 'wrong_script'],
    ['Vi tar emot kunder efter överenskommelse.', 'fa', 'wrong_script'],
    ['Customers are welcome by appointment.', 'ar', 'wrong_script'],
    ['لطفاً برای اولین مراجعه حدود ده دقیقه زودتر برسید و تأییدیه رزرو را همراه داشته باشید.', 'ar', 'wrong_script'],
    ['يرجى الحضور قبل الموعد بعشر دقائق تقريبا في الزيارة الأولى ومعك تأكيد الحجز الخاص بك.', 'fa', 'wrong_script'],
  ];
  for (const [text, l, expected] of wrong) {
    assert.equal(languageEvidence(text, l), expected, `${l}: "${text}"`);
    assert.ok(!languagePlausible(text, l));
  }
});

test('quantities vs positions: ordinals ("first visit") are not quantities; digits and cardinal number words are', () => {
  assert.deepEqual([...numbersIn('Vid första besöket.', ['sv'], false, true)], []);
  assert.deepEqual([...numbersIn('Beim ersten Besuch', ['de'], false, true)], []);
  assert.deepEqual([...numbersIn('في الزيارة الأولى', ['ar'], false, true)], []);
  assert.deepEqual([...numbersIn('mer än femton minuter', ['sv'], false, true)], [15]);
  assert.deepEqual([...numbersIn('بیش از ۱۵ دقیقه', ['fa'], false, true)], [15]);
  assert.deepEqual([...numbersIn('Vid första besöket.', ['sv'])], [1], 'claims still count ordinals (numeric fidelity of statements)');
});
