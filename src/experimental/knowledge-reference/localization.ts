/**
 * EXPERIMENTAL — fixed, fact-free customer copy. Never model-authored, never echoes the question.
 *
 * - FALLBACK is copied verbatim from production `safeUnavailableKnowledge` (src/p2/knowledge-lifecycle.ts) so that
 *   evaluation compares like with like.
 * - REMAINING and NOT_IN_SOURCES follow the owner decision of 2026-11-24 (natural, respectful wording). They state only
 *   that confirmed information is missing: no fact, no promise, no echo of the question. Native review required.
 */
import type { Language } from './types';

export const FALLBACK: Readonly<Record<Language, string>> = Object.freeze({
  en: 'I can’t verify the requested details right now.',
  sv: 'Jag kan inte bekräfta de efterfrågade uppgifterna just nu.',
  de: 'Ich kann die angefragten Angaben gerade nicht bestätigen.',
  es: 'No puedo verificar los detalles solicitados en este momento.',
  fa: 'در حال حاضر نمی‌توانم جزئیات درخواست‌شده را تأیید کنم.',
  ar: 'لا أستطيع التحقق من التفاصيل المطلوبة الآن.',
});

/** Partial answers: closes the reply when some asked details are not (or not consistently) in the sources.
 * Owner decision 2026-11-24: natural, respectful, localized wording. NEW copy, requires native review before customer use. */
export const REMAINING: Readonly<Record<Language, string>> = Object.freeze({
  en: 'I’m sorry, I don’t have confirmed information about the rest of your question.',
  sv: 'Om resten av din fråga har jag tyvärr ingen bekräftad information.',
  de: 'Zum übrigen Teil Ihrer Frage habe ich leider keine bestätigten Informationen.',
  es: 'Lo siento, no tengo información confirmada sobre el resto de su pregunta.',
  fa: 'متأسفانه درباره بقیه سؤال شما اطلاعات تأییدشده‌ای ندارم.',
  ar: 'عذرًا، لا تتوفر لدي معلومات مؤكدة حول بقية سؤالك.',
});

/** Nothing asked is in the sources. Same decision and review requirement as REMAINING. */
export const NOT_IN_SOURCES: Readonly<Record<Language, string>> = Object.freeze({
  en: 'I’m sorry, I don’t have confirmed information about that.',
  sv: 'Tyvärr har jag ingen bekräftad information om det.',
  de: 'Dazu habe ich leider keine bestätigten Informationen.',
  es: 'Lo siento, no tengo información confirmada sobre eso.',
  fa: 'متأسفانه در این مورد اطلاعات تأییدشده‌ای ندارم.',
  ar: 'عذرًا، لا تتوفر لدي معلومات مؤكدة حول ذلك.',
});

/** Verified partial recovery: some available details could not be verified and were withheld. Deliberately does NOT say the
 * information is missing from the sources. NEW copy, native review required. */
export const VERIFICATION_REMAINING: Readonly<Record<Language, string>> = Object.freeze({
  en: 'I’m sorry, I couldn’t verify the rest of the answer right now.',
  sv: 'Resten av svaret kunde jag tyvärr inte bekräfta just nu.',
  de: 'Den Rest der Antwort konnte ich leider gerade nicht bestätigen.',
  es: 'Lo siento, ahora mismo no he podido verificar el resto de la respuesta.',
  fa: 'متأسفانه در حال حاضر نتوانستم بقیه پاسخ را تأیید کنم.',
  ar: 'عذرًا، لم أتمكن الآن من التحقق من بقية الإجابة.',
});
