/** EXPERIMENTAL — structural and grounding checks for the evaluation dataset (no model involved). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDataset, loadFixtureSources } from './dataset';
import { quoteOccursIn } from '../text-checks';
import { LANGUAGES } from '../types';

const d = loadDataset();
const sources = loadFixtureSources();

test('60 cases, exactly 10 per supported language, unique ids', () => {
  assert.equal(d.cases.length, 60);
  for (const l of LANGUAGES) assert.equal(d.cases.filter(c => c.language === l).length, 10, l);
  assert.equal(new Set(d.cases.map(c => c.id)).size, 60);
});

test('contains the exact failed Swedish message of 2026-11-24 and the Persian message of 2026-11-17', () => {
  assert.ok(d.cases.some(c => c.question === 'Jag ska besöka AdMotion Studio för första gången. Hur tidigt bör jag komma, hur hittar jag till entrén och är det ett krav att komma tidigare?'));
  assert.ok(d.cases.some(c => c.question === 'من برای اولین بار می‌خوام بیام. چند دقیقه قبل از وقت رزرو باید اونجا باشم و آیا لازم هست چیزی با خودم بیارم؟'));
});

test('every required category is covered', () => {
  const categories = new Set(d.cases.flatMap(c => c.categories));
  for (const c of ['multipart', 'single', 'paraphrase', 'multi_obligation', 'recommendation_vs_requirement', 'entrance_arrival',
    'follow_up_context', 'absent', 'partial', 'booking_routing']) assert.ok(categories.has(c), c);
  for (const l of LANGUAGES) for (const c of ['multipart', 'follow_up_context', 'absent', 'partial', 'booking_routing'])
    assert.ok(d.cases.some(x => x.language === l && x.categories.includes(c)), `${l} ${c}`);
});

test('every expected fact quote occurs verbatim in its fixture source', () => {
  const byId = new Map(sources.map(s => [s.id, s]));
  for (const [id, fact] of Object.entries(d.facts)) {
    const source = byId.get(fact.sourceId);
    assert.ok(source, `${id}: unknown source`);
    assert.ok(quoteOccursIn(fact.quote, source!.content), `${id}: quote not found`);
    assert.equal(source!.businessId, d.businessId);
  }
});

test('every referenced fact and prohibited claim exists; outcomes are consistent', () => {
  for (const c of d.cases) {
    assert.ok(c.acceptableOutcomes.includes(c.expectedOutcome), c.id);
    for (const p of c.prohibitedClaims) assert.ok(d.globalProhibitedClaims[p], `${c.id}: ${p}`);
    if (c.expectedRoute === 'booking') { assert.equal(c.obligations.length, 0, c.id); assert.equal(c.expectedOutcome, 'booking_route'); continue; }
    assert.ok(c.obligations.length >= 1, c.id);
    for (const o of c.obligations) {
      for (const f of [...o.requiredFacts, ...o.optionalFacts]) assert.ok(d.facts[f], `${c.id}/${o.id}: ${f}`);
      for (const p of o.prohibitedClaims) assert.ok(d.globalProhibitedClaims[p], `${c.id}/${o.id}: ${p}`);
      if (o.answerability === 'none') assert.equal(o.requiredFacts.length, 0, `${c.id}/${o.id}`);
      else assert.ok(o.requiredFacts.length >= 1, `${c.id}/${o.id}`);
    }
    const none = c.obligations.filter(o => o.answerability === 'none').length;
    if (c.expectedOutcome === 'not_in_sources') assert.equal(none, c.obligations.length, c.id);
    if (c.expectedOutcome === 'partial') assert.ok(none >= 1 || c.obligations.some(o => o.answerability === 'partial'), c.id);
  }
});
