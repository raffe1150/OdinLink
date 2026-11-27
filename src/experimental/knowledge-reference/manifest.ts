/**
 * EXPERIMENTAL — software-owned verifier request manifest (binding protocol v2).
 *
 * Genuine pilot 3 (es-01, 2026-11-25): the verifier copied unit u5's 24-hex hash into u3's verdict. Request construction and
 * parsing were correct, so the model's own output was wrong. A model must therefore not be asked to reproduce cryptographic hashes.
 *
 * v2: before the verifier call, software freezes a manifest. Each unit sent gets a short software-assigned key (U1..Un), and the
 * manifest holds deep-frozen snapshots of every unit and of the reply (protocol v3: the reply assembled from the segments sent, in
 * order), plus their hashes and a manifest id. Segment hashes bind text, modality, conditions, citations, kind and paragraph position. The verifier returns
 * only keys. Software then:
 *  - requires each key exactly once (no duplicate, missing or unknown key) and coverage keys from the manifest only;
 *  - translates keys to unit ids through the manifest it built (never through model text);
 *  - publishes from the frozen snapshots, after re-hashing them against the answer it holds (integrity);
 *  - correlates the response with the exact request it sent (request SHA-256 recorded by the transport, not by the model).
 *
 * Limitation, unchanged from v1: no identifier scheme proves that a verdict's MEANING was formed about the unit it is attached to.
 * If a model attaches unit A's verdict to unit B's key while keeping both keys valid (a "swap"), only the semantic content of the
 * verdicts can reveal it. v1's hash echo did not detect that either: a model that confuses two units can copy either hash.
 */
import { createHash } from 'node:crypto';
import type { AnswerUnit, VerifierOutput, VerifierWireOutput } from './types';

const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
export const unitHash = (unit: Pick<AnswerUnit, 'id' | 'text' | 'modality' | 'conditions' | 'citations'>): string =>
  'u_' + sha(JSON.stringify([unit.id, unit.text, unit.modality, unit.conditions, unit.citations.map(c => [c.sourceId, c.revision, c.quote])])).slice(0, 24);
export const draftHash = (draft: string): string => 'd_' + sha(draft).slice(0, 24);
/** Protocol v3 segment hash: the v1-compatible unit hash plus the segment's kind and paragraph position, so structure is bound too. */
export const segmentHash = (unit: AnswerUnit): string =>
  's_' + sha(JSON.stringify([unitHash(unit), unit.kind ?? 'claim', !!unit.newParagraph])).slice(0, 24);

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

export type ManifestEntry = Readonly<{ key: string; unitId: string; hash: string; unit: AnswerUnit; evidence: readonly string[] }>;
export type VerifierManifest = Readonly<{
  id: string; entries: readonly ManifestEntry[]; byKey: ReadonlyMap<string, ManifestEntry>; byUnitId: ReadonlyMap<string, ManifestEntry>;
  draft: string; draftHash: string; evidenceMapId: string;
}>;

export const UNIT_KEY = /^U[1-9]\d{0,2}$/u;

/** Built once, before the verifier request; never mutated (snapshots are deep copies, deep-frozen). */
export function buildManifest(units: readonly AnswerUnit[], draft: string, evidenceMapId = ''): VerifierManifest {
  const ids = units.map(u => u.id);
  if (new Set(ids).size !== ids.length) throw new Error('MANIFEST_DUPLICATE_UNIT_ID');
  const entries = units.map((u, i) => deepFreeze({ key: `U${i + 1}`, unitId: u.id, hash: segmentHash(u), unit: deepFreeze(structuredClone(u)),
    evidence: Object.freeze([...(u.evidence ?? [])]) }));
  const dHash = draftHash(draft);
  // The evidence map id binds the manifest to the exact passages the references resolved against (evidence substitution → new id).
  const id = 'm_' + sha(JSON.stringify([entries.map(e => [e.key, e.unitId, e.hash, e.evidence]), dHash, evidenceMapId])).slice(0, 24);
  return Object.freeze({ id, entries: Object.freeze(entries), byKey: new Map(entries.map(e => [e.key, e])), byUnitId: new Map(entries.map(e => [e.unitId, e])),
    draft, draftHash: dHash, evidenceMapId });
}

export type BindingFailure = Readonly<{ code: 'VERIFIER_BINDING_MISMATCH' | 'VERIFIER_OBLIGATION_UNIT_UNKNOWN'; detail: string; obligationId?: string }>;

/** Strict v2 binding. Fails closed on any duplicate, missing or unknown key. Never repairs. */
export function bindVerdicts(manifest: VerifierManifest, wire: VerifierWireOutput,
  resolveConflict: (refs: readonly string[]) => readonly Readonly<{ sourceId: string; quote: string }>[] = () => []): { output?: VerifierOutput; failure?: BindingFailure } {
  const seen = new Set<string>();
  for (const v of wire.units) {
    if (!manifest.byKey.has(v.unitKey)) return { failure: { code: 'VERIFIER_BINDING_MISMATCH', detail: `unknown:${v.unitKey}` } };
    if (seen.has(v.unitKey)) return { failure: { code: 'VERIFIER_BINDING_MISMATCH', detail: `duplicate:${v.unitKey}` } };
    seen.add(v.unitKey);
  }
  for (const e of manifest.entries) if (!seen.has(e.key)) return { failure: { code: 'VERIFIER_BINDING_MISMATCH', detail: `missing:${e.key}` } };
  for (const o of wire.obligations) for (const k of o.coveredByUnits)
    if (!manifest.byKey.has(k)) return { failure: { code: 'VERIFIER_OBLIGATION_UNIT_UNKNOWN', detail: `unknown:${k}`, obligationId: o.id } };
  const toId = (k: string) => manifest.byKey.get(k)!.unitId;
  return { output: Object.freeze({
    obligations: wire.obligations.map(({ conflictingEvidence, ...o }) => ({ ...o, conflictingQuotes: resolveConflict(conflictingEvidence),
      coveredByUnits: o.coveredByUnits.map(toId) })),
    units: wire.units.map(({ unitKey, ...v }) => ({ unitId: toId(unitKey), ...v })),
    reply: wire.reply,
  }) };
}

/** Before publication: the answer still matches the frozen snapshots and the draft that was verified. */
export function manifestIntact(manifest: VerifierManifest, units: readonly AnswerUnit[], draft: string, evidenceMapId = manifest.evidenceMapId): boolean {
  const byId = new Map(units.map(u => [u.id, u]));
  return evidenceMapId === manifest.evidenceMapId && draftHash(draft) === manifest.draftHash && manifest.entries.every(e => {
    const u = byId.get(e.unitId);
    return !!u && segmentHash(u) === e.hash && segmentHash(e.unit) === e.hash;
  });
}
