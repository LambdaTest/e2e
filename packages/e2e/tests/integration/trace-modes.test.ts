/**
 * `trace` modes: which attempts record a trace and which traces are kept,
 * from the config, a test, and `--trace`, for a test and for a serial
 * group's shared session alike. Driven through the runner on the real web
 * engine, whose traces are what a user reads.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { runProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from 'e2e';

test('passes first time', async ({ app }) => {
  await app.open();
});

test('always fails', async ({ app }) => {
  await app.open();
  throw new Error('nope');
});

test('first retry only', { trace: 'on-first-retry' }, async ({ app }) => {
  await app.open();
  throw new Error('nope');
});

test('kept on failure, passing', { trace: 'retain-on-failure' }, async ({ app }) => {
  await app.open();
});

test('kept on failure, failing', { trace: 'retain-on-failure' }, async ({ app }) => {
  await app.open();
  throw new Error('nope');
});

test.describe('wizard', { serial: true }, () => {
  test('step 1', async ({ app }) => {
    await app.open();
  });

  test('step 2 fails', async () => {
    throw new Error('nope');
  });
});
`;

/** How many trace artifacts each attempt of a result carries, by attempt index. */
function tracesPerAttempt(outcome: RunOutcome, title: string): number[] {
  const result = outcome.report.run.results.find((candidate) => candidate.titlePath.at(-1) === title)!;
  return result.attempts.map((attempt) => attempt.artifacts.filter((artifact) => artifact.kind === 'trace').length);
}

describe('trace modes', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it(
    'records retries only under on-all-retries, --trace wins over the config, and a test mode wins over the flag',
    async () => {
      const { outcome, project } = await runProject(
        { 'tests/suite.e2e.ts': SUITE },
        { appUrl: app.url, config: { retries: 2, cache: 'off', trace: 'off' }, runOptions: { trace: 'on-all-retries' } },
      );
      try {
        expect(tracesPerAttempt(outcome, 'passes first time')).toEqual([0]);
        expect(tracesPerAttempt(outcome, 'always fails')).toEqual([0, 1, 1]);
        expect(tracesPerAttempt(outcome, 'first retry only')).toEqual([0, 1, 0]);
        expect(tracesPerAttempt(outcome, 'kept on failure, passing')).toEqual([0]);
        expect(tracesPerAttempt(outcome, 'kept on failure, failing')).toEqual([1, 1, 1]);
        const group = outcome.report.run.serialGroups[0]!;
        expect(group.attempts.map((attempt) => attempt.artifacts.filter((artifact) => artifact.kind === 'trace').length)).toEqual([0, 1, 1]);
        // A mode somebody set is required: an attempt that never started a trace must not stop one.
        const attempts = [...outcome.report.run.results.flatMap((result) => result.attempts), ...group.attempts];
        expect(attempts.map((attempt) => [attempt.cleanup, attempt.secondaryErrors])).toEqual(
          attempts.map(() => ['complete', []]),
        );
      } finally {
        project.cleanup();
      }
    },
    180_000,
  );
});
