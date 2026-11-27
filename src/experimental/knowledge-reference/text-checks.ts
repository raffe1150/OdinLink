/**
 * EXPERIMENTAL — deterministic text checks for the Knowledge Answer reference path.
 *
 * Objective invariants only: exact quotes, numbers and script/language plausibility. Meaning (modality, negation,
 * conditions, qualifiers, entailment) is judged by the independent verifier, whose per-unit verdicts are binding.
 */
import { createHash } from 'node:crypto';
import type { Language } from './types';

export const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const DIGITS: Record<string, string> = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};
/** NFC, ASCII digits, unified quotes/dashes, Arabic-script presentation variants left as-is, collapsed whitespace. */
export function normalizeText(value: string): string {
  return value.normalize('NFC')
    .replace(/[\u06F0-\u06F9\u0660-\u0669]/gu, d => DIGITS[d] ?? d)
    .replace(/[\u2018\u2019\u201A\u2032]/gu, "'").replace(/[\u201C\u201D\u201E\u2033]/gu, '"')
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, '')
    .replace(/\s+/gu, ' ').trim();
}
/** Exact citation match: only whitespace, digit script, quote/dash glyphs and invisible marks are normalized. */
export function quoteOccursIn(quote: string, content: string): boolean {
  const q = normalizeText(quote);
  return q.length > 0 && normalizeText(content).includes(q);
}
export const MIN_QUOTE_CHARS = 15;

// ---------- numbers ----------
type WordTable = Readonly<Record<string, number>>;
/** Unambiguous number words (cardinal and ordinal). Words that double as articles or "other" are excluded. */
const NUMBER_WORDS: Readonly<Record<Language, WordTable>> = {
  sv: { två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, sju: 7, åtta: 8, nio: 9, tio: 10, elva: 11, tolv: 12, femton: 15, tjugo: 20, tjugoen: 21, trettio: 30,
    tredje: 3, fjärde: 4, femte: 5, första: 1, kvart: 15 },
  en: { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
    'twenty-one': 21, thirty: 30, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, quarter: 15 },
  de: { zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, fünfzehn: 15, zwanzig: 20,
    einundzwanzig: 21, dreißig: 30, ersten: 1, erste: 1, zweiten: 2, zweite: 2, dritten: 3, dritte: 3, viertelstunde: 15 },
  es: { dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, quince: 15, veinte: 20,
    veintiuno: 21, veintiún: 21, treinta: 30, primera: 1, primer: 1, primero: 1, segunda: 2, segundo: 2, tercera: 3, tercer: 3 },
  fa: { دو: 2, سه: 3, چهار: 4, پنج: 5, شش: 6, هفت: 7, هشت: 8, ده: 10, یازده: 11, دوازده: 12, پانزده: 15, بیست: 20, سی: 30,
    اول: 1, دوم: 2, سوم: 3, ربع: 15 },
  ar: { اثنان: 2, اثنين: 2, ثلاث: 3, ثلاثة: 3, أربع: 4, أربعة: 4, خمس: 5, خمسة: 5, ست: 6, ستة: 6, سبع: 7, سبعة: 7, ثماني: 8, ثمانية: 8,
    تسع: 9, تسعة: 9, عشر: 10, عشرة: 10, عشرين: 20, عشرون: 20, ثلاثين: 30, الأول: 1, الأولى: 1, الثاني: 2, الثانية: 2, الثالث: 3, ربع: 15 },
};
/** Source-side extras: words that are ambiguous in customer text but count as evidence when present in a quote. */
const SOURCE_EXTRA: WordTable = { andra: 2, ett: 1, en: 1, one: 1, ein: 1, eine: 1, un: 1, una: 1, uno: 1, یک: 1, واحد: 1, نه: 9 }; // Persian «نه» also means "no".

const tokens = (text: string): string[] => normalizeText(text).toLowerCase().split(/[^\p{L}\p{N}\u200C-]+/u).filter(Boolean);

/** Numbers a text asserts: digits plus unambiguous number words of the given languages. "21-dagars" → 21. */
/** Ordinal number words ("first", "andra", "الأولى"): positions, not quantities. Excluded when only quantities are wanted. */
const ORDINALS: ReadonlySet<string> = new Set(['första', 'tredje', 'fjärde', 'femte', 'first', 'second', 'third', 'fourth', 'fifth', 'ersten', 'erste',
  'zweiten', 'zweite', 'dritten', 'dritte', 'primera', 'primer', 'primero', 'segunda', 'segundo', 'tercera', 'tercer', 'اول', 'دوم', 'سوم',
  'الأول', 'الأولى', 'الثاني', 'الثانية', 'الثالث']);
export function numbersIn(text: string, languages: readonly Language[], sourceSide = false, quantitiesOnly = false): Set<number> {
  const found = new Set<number>();
  for (const match of normalizeText(text).matchAll(/\d+(?:[.,]\d+)?/gu)) found.add(Number(match[0].replace(',', '.')));
  const words = tokens(text);
  for (const word of words) {
    if (quantitiesOnly && ORDINALS.has(word)) continue;
    for (const language of languages) { const n = NUMBER_WORDS[language][word]; if (n !== undefined) found.add(n); }
    if (sourceSide && SOURCE_EXTRA[word] !== undefined) found.add(SOURCE_EXTRA[word]);
  }
  return found;
}

// Semantic judgments (modality, negation, conditions, qualifiers, entailment) are NOT made here. Keyword heuristics for them
// produced false positives in the genuine pilot (2026-11-24: six "not mandatory" units rejected as MODALITY_UNSUPPORTED) and
// duplicated the independent verifier's binding verdicts (modalityCorrect, conditionsPreserved, verdict). They live there only.
export const ALL_LANGUAGES: readonly Language[] = ['sv', 'en', 'de', 'es', 'fa', 'ar'];

// ---------- language / script ----------
const STOPWORDS: Readonly<Record<'sv' | 'en' | 'de' | 'es', ReadonlySet<string>>> = {
  sv: new Set(['och', 'att', 'det', 'är', 'du', 'på', 'för', 'med', 'inte', 'till', 'som', 'av', 'kan', 'din', 'ditt', 'ska', 'vid', 'från', 'bör', 'eller', 'finns', 'har', 'innan']),
  en: new Set(['the', 'and', 'to', 'is', 'you', 'of', 'for', 'at', 'not', 'can', 'in', 'on', 'your', 'are', 'it', 'with', 'from', 'should', 'or', 'there', 'before']),
  de: new Set(['und', 'der', 'die', 'das', 'ist', 'sie', 'nicht', 'zu', 'mit', 'den', 'ein', 'eine', 'für', 'auf', 'im', 'ihr', 'ihre', 'es', 'vor', 'oder', 'dem', 'sollten']),
  es: new Set(['el', 'la', 'de', 'que', 'y', 'en', 'los', 'las', 'es', 'no', 'para', 'con', 'por', 'un', 'una', 'su', 'se', 'del', 'al', 'o', 'antes', 'hay', 'puede']),
};
const PERSIAN_ONLY = /[پچژگیک]/gu; // U+067E U+0686 U+0698 U+06AF U+06CC U+06A9
const ARABIC_ONLY = /[يكة]/gu;     // U+064A U+0643 U+0629

export type LanguageEvidence = 'consistent' | 'uncertain' | 'wrong_script' | 'other_language';
/**
 * Weak, conservative language evidence for `text` in `language`. Two different kinds of signal are kept apart:
 *  - wrong_script: OBJECTIVE. Arabic-script text for a Latin-script language or vice versa (proper names in Latin script are
 *    tolerated in RTL text), or, with enough letters, Persian-only vs Arabic-only letters for the wrong one of fa/ar.
 *  - other_language: POSITIVE evidence of another supported Latin-script language: at least two of its function words and more
 *    than the requested language has.
 *  - uncertain: too short, or no function words of any supported language (2026-11-25, Pilot 5 sv-08: the valid Swedish sentence
 *    "Vi tar emot kunder efter överenskommelse." has six words and none in the small function-word lists, and was rejected).
 *    Uncertain text is NOT rejected here: the independent verifier's per-unit languageCorrect verdict is binding and resolves it.
 */
export function languageEvidence(text: string, language: Language): LanguageEvidence {
  const t = normalizeText(text);
  const arabicLetters = (t.match(/\p{Script=Arabic}/gu) || []).length;
  const latinLetters = (t.match(/\p{Script=Latin}/gu) || []).length;
  const letters = arabicLetters + latinLetters;
  if (letters < 8) return 'uncertain';
  if (language === 'fa' || language === 'ar') {
    if (arabicLetters / letters < 0.6) return 'wrong_script';
    if (arabicLetters < 25) return 'uncertain';
    const persian = (t.match(PERSIAN_ONLY) || []).length, arabic = (t.match(ARABIC_ONLY) || []).length;
    if (persian === arabic) return 'uncertain';
    return (language === 'fa' ? persian > arabic : arabic > persian) ? 'consistent' : 'wrong_script';
  }
  if (latinLetters / letters < 0.8) return 'wrong_script';
  const words = tokens(t);
  if (words.length < 6) return 'uncertain';
  const score = (l: keyof typeof STOPWORDS) => words.filter(w => STOPWORDS[l].has(w)).length;
  const own = score(language);
  const best = Math.max(...(['sv', 'en', 'de', 'es'] as const).filter(l => l !== language).map(score));
  if (best >= 2 && best > own) return 'other_language';
  return own > 0 && own >= best ? 'consistent' : 'uncertain';
}

/** Deterministic gate: rejects only objective script errors and positive evidence of another language. */
export const languagePlausible = (text: string, language: Language): boolean => {
  const e = languageEvidence(text, language);
  return e === 'consistent' || e === 'uncertain';
};
