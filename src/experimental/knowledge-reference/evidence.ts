/**
 * EXPERIMENTAL — software-owned compact evidence references (answer citation protocol v2).
 *
 * Measured on Pilot 3/4 (2026-11-25): about 18% of the answer output was verbatim quotes, and every citation also made the model copy a
 * 36-character source UUID and a 26-character revision id. That is the same class of model-copied identifier that broke binding in es-01.
 *
 * v2: when the corpus is pinned, software splits each source's model-visible text into sentence passages and gives each a short reference
 * (E1, E2, …), unique across the corpus of this one tenant and turn. The models see the passages with their references. The answerer
 * cites references only. Software resolves them to immutable {sourceId, revision, verbatim passage text}, so provenance, revision and
 * exact source text come from software, never from model output. A reference that is malformed, unknown, redacted or from a map that
 * was not built from this exact pinned corpus is refused.
 *
 * Precision: passages are sentences (with heading lines kept separate). On the genuine citations of Pilots 2–4, 17 of 18 distinct quotes
 * are exact runs of whole passages; one quoted a leading clause of a sentence and would now cite the whole sentence (wider, never narrower).
 */
import { createHash } from 'node:crypto';
import { normalizeText } from './text-checks';
import { REDACTION } from './secrets';
import type { Citation, PinnedSource } from './types';

export const EVIDENCE_REF = /^E[1-9]\d{0,3}$/u;
export type EvidencePassage = Readonly<{ ref: string; sourceId: string; revision: string; /** verbatim slice of modelContent */ text: string }>;
export type EvidenceMap = Readonly<{ id: string; businessId: number; passages: readonly EvidencePassage[]; byRef: ReadonlyMap<string, EvidencePassage> }>;

const LIST_NUMBER = /(^|\n)[ \t]*\d{1,3}\.$/u;
/** Splits text into verbatim slices: blank lines and short heading lines end a passage; sentence-final punctuation followed by whitespace
 * ends one, except a list number at the start of a line ("2. Hitta till studion"). Concatenating the slices reproduces the text. */
export function splitPassages(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const push = (end: number) => { if (end > start) { out.push(text.slice(start, end)); start = end; } };
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineEnd = offset + line.length + (i < lines.length - 1 ? 1 : 0);
    // sentence boundaries inside the line
    const re = /[.!?؟](?=\s|$)/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const abs = offset + m.index + 1;
      if (LIST_NUMBER.test(text.slice(Math.max(0, abs - 8), abs))) continue;
      let end = abs;
      while (end < lineEnd && /[ \t]/u.test(text[end])) end++;
      if (end >= offset + line.length) end = lineEnd;
      push(end);
    }
    const trimmed = line.trim();
    const next = (lines[i + 1] ?? '').trim();
    const heading = trimmed.length > 0 && trimmed.length <= 60 && !/[.,;:!?؟،]$/u.test(trimmed) && /^(\p{Lu}|\d{1,3}\.\s|#|\*\*)/u.test(next);
    if (trimmed === '' || heading || /^(#|\*\*)/u.test(trimmed)) push(lineEnd);
    offset = lineEnd;
  }
  push(text.length);
  return out.filter(p => normalizeText(p).length > 0);
}

/** Built once from the pinned sources of one tenant; deep-frozen. Redacted passages get no reference. */
export function buildEvidenceMap(businessId: number, sources: readonly PinnedSource[]): EvidenceMap {
  const passages: EvidencePassage[] = [];
  for (const source of sources) for (const text of splitPassages(source.modelContent)) {
    if (normalizeText(text) === REDACTION || normalizeText(text).includes(REDACTION)) continue;
    passages.push(Object.freeze({ ref: `E${passages.length + 1}`, sourceId: source.id, revision: source.revision, text }));
  }
  const id = 'e_' + createHash('sha256').update(JSON.stringify([businessId, passages.map(p => [p.ref, p.sourceId, p.revision, p.text])])).digest('hex').slice(0, 24);
  return Object.freeze({ id, businessId, passages: Object.freeze(passages), byRef: new Map(passages.map(p => [p.ref, p])) });
}

export type EvidenceFailure = Readonly<{ code: 'EVIDENCE_REF_UNKNOWN' | 'EVIDENCE_MAP_MISMATCH'; detail: string }>;

/** A map is usable only for the exact pinned corpus it was built from (same tenant, same sources, same revisions, same text). */
export function evidenceMapMatches(map: EvidenceMap, businessId: number, sources: readonly PinnedSource[]): boolean {
  return map.businessId === businessId && map.id === buildEvidenceMap(businessId, sources).id;
}

/** Resolves a unit's references to immutable citations. Consecutive passages of one source merge into one citation. */
export function resolveEvidence(map: EvidenceMap, refs: readonly string[]): { citations?: Citation[]; failure?: EvidenceFailure } {
  const unique = [...new Set(refs)];
  const passages: EvidencePassage[] = [];
  for (const ref of unique) {
    const p = EVIDENCE_REF.test(ref) ? map.byRef.get(ref) : undefined;
    if (!p) return { failure: { code: 'EVIDENCE_REF_UNKNOWN', detail: `ref:${ref.slice(0, 12)}` } };
    passages.push(p);
  }
  const citations: Citation[] = [];
  let prev: EvidencePassage | undefined;
  for (const p of passages) {
    const consecutive = prev && prev.sourceId === p.sourceId && Number(p.ref.slice(1)) === Number(prev.ref.slice(1)) + 1;
    if (consecutive) { const last = citations.pop()!; citations.push(Object.freeze({ ...last, quote: last.quote + p.text })); }
    else citations.push(Object.freeze({ sourceId: p.sourceId, revision: p.revision, quote: p.text }));
    prev = p;
  }
  return { citations };
}

/** Model-facing passage listing (whitespace-normalized for readability; resolution always uses the verbatim slice). */
export const renderPassage = (p: EvidencePassage) => `[${p.ref}] ${normalizeText(p.text)}`;
