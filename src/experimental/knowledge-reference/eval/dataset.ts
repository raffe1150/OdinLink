/** EXPERIMENTAL — evaluation dataset types and loader. Grading is human review; see dataset-v1.json → grading. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Language, SourceRecord } from '../types';

export type EvalObligation = Readonly<{
  id: string; description: string; answerability: 'full' | 'partial' | 'none';
  requiredFacts: readonly string[]; optionalFacts: readonly string[]; requiredConditions: readonly string[]; prohibitedClaims: readonly string[];
}>;
export type EvalCase = Readonly<{
  id: string; language: Language; categories: readonly string[]; history: readonly { role: 'user' | 'assistant'; content: string }[];
  question: string; expectedRoute: 'knowledge' | 'booking';
  expectedOutcome: 'complete' | 'partial' | 'not_in_sources' | 'booking_route'; acceptableOutcomes: readonly string[];
  obligations: readonly EvalObligation[]; prohibitedClaims: readonly string[]; notes?: string;
}>;
export type EvalDataset = Readonly<{
  version: string; businessId: number; fixture: string;
  sources: Readonly<{ PDF: string; TXT: string; KL: string }>;
  facts: Readonly<Record<string, { sourceId: string; quote: string; meaning: string }>>;
  globalProhibitedClaims: Readonly<Record<string, string>>;
  cases: readonly EvalCase[];
}>;

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
export const loadDataset = (): EvalDataset => JSON.parse(readFileSync(here('./dataset-v1.json'), 'utf8'));

/** Fixture rows mapped to the module's SourceRecord shape. Repository root is four levels up from this folder. */
export function loadFixtureSources(fixture = loadDataset().fixture): SourceRecord[] {
  const raw = JSON.parse(readFileSync(here(`../../../../${fixture}`), 'utf8'));
  return raw.sources.map((s: any) => ({ id: s.id, businessId: s.business_id, title: s.title, type: s.type, status: s.status,
    content: s.content, updatedAt: s.updated_at }));
}
