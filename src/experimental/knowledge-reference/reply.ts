/**
 * EXPERIMENTAL — answer protocol v3: the customer reply is authored ONCE, as ordered segments (claims and limitations).
 *
 * Measured on 17 genuine drafts (Pilots 2–5): in 11 the draft was exactly the unit texts in order with paragraph breaks; of the other
 * six, three added a limitation sentence, one added a one-word connective, one merged two units into one sentence and one reordered
 * the units. Each is expressible as segments. v2 paid for the same text twice (draft ≈ units ×1.01 bytes). v3 asks for the reply once: each segment's text IS the published text, its evidence and modality bind to exactly
 * that text, and paragraph structure and order are part of the segment list. Software assembles; it never rewrites.
 */
import type { AnswerSegmentWire, AnswerUnit } from './types';

/**
 * Coupled-claim rule (2026-11-25, Pilot 6 es-08): a permission and its restriction taken from ONE passage ("bikes may be parked in
 * the courtyard, but not in front of the entrance") must be verified together; split across two segments, the permission alone is
 * correctly judged to drop its restriction. Before verification, software therefore joins adjacent claim segments of the same
 * paragraph that cite a common passage into one segment. The published text is unchanged (same paragraph → joined by a space);
 * the verifier judges the joined text as one unit, so its verdict, positive or negative, applies to both parts.
 */
export function coupleSegments(reply: readonly AnswerSegmentWire[]): { reply: AnswerSegmentWire[]; merged: string[] } {
  const out: AnswerSegmentWire[] = [];
  const merged: string[] = [];
  for (const s of reply) {
    const prev = out.at(-1);
    if (prev && prev.kind === 'claim' && s.kind === 'claim' && !s.newParagraph && s.evidence.some(r => prev.evidence.includes(r))) {
      out[out.length - 1] = { ...prev, text: `${prev.text.trim()} ${s.text.trim()}`,
        modality: prev.modality === s.modality ? prev.modality : 'descriptive',
        conditions: [...new Set([...prev.conditions, ...s.conditions])], evidence: [...new Set([...prev.evidence, ...s.evidence])],
        addresses: [...new Set([...prev.addresses, ...s.addresses])] };
      merged.push(s.id);
    } else out.push(s);
  }
  return { reply: out, merged };
}

/** The authored reply: segment texts in order; a segment with newParagraph starts a new paragraph. */
export function assembleReply(segments: readonly AnswerUnit[]): string {
  return assemble(segments, () => true);
}

/** A subset of the authored reply, in authored order. A published segment starts a new paragraph when it, or any segment omitted
 * since the previous published one, started one: paragraph structure survives omission, nothing is reordered or rewritten. */
export function assembleSubset(segments: readonly AnswerUnit[], published: ReadonlySet<string>): string {
  return assemble(segments, s => published.has(s.id));
}

function assemble(segments: readonly AnswerUnit[], keep: (s: AnswerUnit) => boolean): string {
  let out = '';
  let breakPending = false;
  for (const s of segments) {
    breakPending ||= !!s.newParagraph;
    if (!keep(s)) continue;
    const text = s.text.trim();
    if (!text) continue;
    out += out ? (breakPending ? '\n\n' : ' ') + text : text;
    breakPending = false;
  }
  return out;
}
