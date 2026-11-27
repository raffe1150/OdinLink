/**
 * EXPERIMENTAL — deterministic protection of internal secrets found in Knowledge sources.
 *
 * Two independent layers, neither relying on a prompt:
 *  1. Input redaction: any source line that announces a secret, password, internal/test code or credential, and any
 *     credential-shaped token anywhere, is replaced before the corpus is shown to either model.
 *  2. Output guard: every unit, draft and final reply is checked against the protected tokens after folding
 *     (case, diacritics, spacing, hyphens, digit scripts). A match removes the unit or blocks the reply.
 */
import { normalizeText } from './text-checks';

const SECRET_LINE: readonly RegExp[] = [
  /hemlig|lösenord|pinkod|säkerhetskod|testkod|intern(?:a)? kod|åtkomstkod/iu,
  /secret|password|passcode|pass code|internal code|test code|access code|api[ -]?key|\btoken\b/iu,
  /geheim|passwort|kennwort|interne[rn]? code|testcode|zugangscode/iu,
  /secreto|secreta|contraseña|clave interna|código interno|código de prueba/iu,
  /محرمانه|رمز عبور|گذرواژه|کد مخفی|کد داخلی|کد آزمایشی/u,
  /(^|[^\p{L}])(?:سري|سرية|السري|السرية)([^\p{L}]|$)|كلمة المرور|كلمة السر|رمز داخلي/u,
];
/** Credential-shaped tokens are protected wherever they occur. */
const CREDENTIAL_TOKEN = /\b(?:sk|pk|rk|proj|org|key)[-_][A-Za-z0-9_-]{12,}\b|\b[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9])/gu;
/** Code-like tokens inside a protected line: hyphen/underscore-joined parts with a digit, or mixed letters+digits ≥ 5. */
const CODE_TOKEN = /[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+|(?=[\p{L}\p{N}]*\p{N})(?=[\p{L}\p{N}]*\p{L})[\p{L}\p{N}]{5,}/gu;

export const REDACTION = '[redacted internal information]';

/** Case/diacritic/spacing/punctuation-insensitive fingerprint: "BLÅ-RÄV-742" ≡ "bla rav 742" ≡ "BLARAV742". */
export const fold = (text: string): string =>
  normalizeText(text).normalize('NFKD').replace(/\p{M}+/gu, '').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');

export type ProtectedContent = Readonly<{ modelContent: string; tokens: readonly string[] }>;

export function protectContent(content: string, extraTerms: readonly string[] = []): ProtectedContent {
  const tokens = new Set<string>();
  // Sentence-level, so a secret wrapped across PDF line breaks is still redacted whole. Separators are kept.
  const parts = content.split(/((?<=[.!?\u061F])\s+|\n\s*\n)/u);
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part;
    let text = part;
    for (const m of part.matchAll(CREDENTIAL_TOKEN)) { tokens.add(fold(m[0])); text = text.replace(m[0], REDACTION); }
    if (SECRET_LINE.some(r => r.test(normalizeText(part)))) {
      for (const m of part.matchAll(CODE_TOKEN)) if (fold(m[0]).length >= 4) tokens.add(fold(m[0]));
      return REDACTION;
    }
    return text;
  });
  for (const term of extraTerms) if (fold(term).length >= 4) tokens.add(fold(term));
  return Object.freeze({ modelContent: out.join(''), tokens: Object.freeze([...tokens]) });
}

export const disclosesProtected = (text: string, tokens: readonly string[]): boolean => {
  if (!tokens.length) return false;
  const folded = fold(text);
  return tokens.some(token => folded.includes(token));
};
