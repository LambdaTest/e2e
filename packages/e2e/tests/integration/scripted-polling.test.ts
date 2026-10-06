/**
 * Polling through the real runner against the scripted engine: matchers poll
 * until the tree catches up, and a negated matcher holds for its grace window.
 */

import { describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import { passed, scriptedSuite, step } from '../helpers/scripted-suite.ts';

const POLLING = `import { test, expect } from 'e2e';

test('a late node passes toBeVisible', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('button', { name: 'Late arrival' })).toHaveCount(0);
  await screen.getByRole('button', { name: 'Reveal' }).tap();
  await expect(screen.getByRole('button', { name: 'Late arrival' })).toBeVisible({ timeout: 1500 });
  await screen.getByRole('button', { name: 'Late arrival' }).waitFor({ state: 'visible' });
});

test('a growing count passes toHaveCount', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Load more' }).tap();
  await expect(screen.getByRole('list', { name: 'Growing' }).getByRole('listitem')).toHaveCount(3, { timeout: 1500 });
});

test('a changing value, text, and state pass their matchers', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('menuitem', { name: 'Save' })).toBeDisabled();
  await screen.getByRole('button', { name: 'Advance' }).tap();
  await expect(screen.getByRole('spinbutton', { name: 'Progress' })).toHaveValue('100', { timeout: 1500 });
  await expect(screen.getByRole('status', { name: 'Ticker' })).toHaveText('tock', { timeout: 1500 });
  await expect(screen.getByRole('menuitem', { name: 'Save' })).toBeEnabled({ timeout: 1500 });
});

test('a negated matcher waits out the grace window', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByText('Hidden content')).not.toBeVisible({ timeout: 1500 });
});

test('a negated matcher waits for the flip, then the grace window', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Reveal' }).tap();
  await expect(screen.getByRole('status', { name: 'Loading' })).not.toBeVisible({ timeout: 2500 });
  await screen.getByRole('status', { name: 'Loading' }).waitFor({ state: 'hidden' });
});
`;

describe('scripted engine: polling', () => {
  const run = scriptedSuite('polling.e2e.ts', POLLING);

  it('polls until the tree catches up', () => {
    assertValidReport(run.outcome.report);
    const late = passed(run.outcome, 'a late node passes toBeVisible');
    expect(step(late, 'expect.toBeVisible').durationMs).toBeGreaterThanOrEqual(200);
    const growing = passed(run.outcome, 'a growing count passes toHaveCount');
    expect(step(growing, 'expect.toHaveCount').durationMs).toBeGreaterThanOrEqual(300);
    const changing = passed(run.outcome, 'a changing value, text, and state pass their matchers');
    expect(step(changing, 'expect.toHaveValue').durationMs).toBeGreaterThanOrEqual(150);
  });

  it('holds a negated matcher for the grace window', () => {
    const held = passed(run.outcome, 'a negated matcher waits out the grace window');
    expect(step(held, 'expect.not.toBeVisible').durationMs).toBeGreaterThanOrEqual(900);
    const flipped = passed(run.outcome, 'a negated matcher waits for the flip, then the grace window');
    expect(step(flipped, 'expect.not.toBeVisible').durationMs).toBeGreaterThanOrEqual(1_150);
  });
});
