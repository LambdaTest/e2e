import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import {
  resultByTitle,
  runProjectWithConfigFile,
  workerFakeConfigSource,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';

const BODY_SUITE = `import { test, expect } from 'e2e';

const counters = globalThis as { abandonedReads?: number };

test('an unawaited poll fails the body that started it', async () => {
  expect
    .poll(() => {
      counters.abandonedReads = (counters.abandonedReads ?? 0) + 1;
      return false;
    }, { timeout: 30_000 })
    .toBe(true);
});

test('a body error stays primary with the unawaited poll beside it', async () => {
  expect.poll(() => false, { timeout: 200 }).toBe(true);
  throw new Error('the body gave up');
});

test('an awaited failing poll fails with its own error', async () => {
  await expect.poll(() => false, { timeout: 100 }).toBe(true);
});

test('an awaited passing poll passes', async () => {
  let reads = 0;
  await expect.poll(() => ++reads, { interval: 10 }).toBeGreaterThan(3);
});

test('the test after them is never charged, and the abandoned poll read no more', async () => {
  const before = counters.abandonedReads;
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(counters.abandonedReads).toBe(before);
});
`;

const HOOKS_SUITE = `import { test, expect } from 'e2e';

test.describe('afterEach', () => {
  test.afterEach(async () => {
    expect.poll(() => false, { timeout: 200 }).toBe(true);
  });
  test('owns the afterEach poll', async () => {});
});

test.describe('beforeEach', () => {
  test.beforeEach(async () => {
    expect.poll(() => false, { timeout: 200 }).toBe(true);
  });
  test('owns the beforeEach poll', async () => {});
});

test.describe('afterAll', () => {
  test.afterAll(async () => {
    expect.poll(() => false, { timeout: 200 }).toBe(true);
  });
  test('runs before the afterAll poll', async () => {});
});

test('the test after the hooks is never charged', async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
});
`;

/** Every test of a file sets up every fixture its `test.extend` defines, so each fixture gets a file. */
const LEAKY_FIXTURE_SUITE = `import { test as base, expect } from 'e2e';

const test = base.extend<{ leaky: number }>({
  leaky: async (_fixtures, use) => {
    await use(1);
    expect.poll(() => false, { timeout: 200 }).toBe(true);
  },
});

test('owns the fixture teardown poll', async ({ leaky }) => {
  expect(leaky).toBe(1);
});
`;

const TIDY_FIXTURE_SUITE = `import { test as base, expect } from 'e2e';

const test = base.extend<{ tidy: number }>({
  tidy: async (_fixtures, use) => {
    await use(1);
    await expect.poll(() => true, { timeout: 200 }).toBe(true);
  },
});

test('an awaited poll in a fixture teardown passes', async ({ tidy }) => {
  expect(tidy).toBe(1);
});
`;

const BEFORE_ALL_SUITE = `import { test, expect } from 'e2e';

test.describe('beforeAll', () => {
  test.beforeAll(async () => {
    expect.poll(() => false, { timeout: 200 }).toBe(true);
  });
  test('sits under the beforeAll poll', async () => {});
});

test('the test after the beforeAll is never charged', async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
});
`;

/** A body the timeout cut keeps running; the poll it starts later is its own, never the next test's. */
const TIMED_OUT_SUITE = `import { test, expect } from 'e2e';

test('times out, then polls from its leftover body', { timeout: 300 }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await expect.poll(() => false, { timeout: 500 }).toBe(true);
});

test('runs while the leftover body polls, and is never charged', async () => {
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
`;

const STEPS_SUITE = `import { test } from 'e2e';

test('a step call without await', async ({ app }) => {
  app.open();
});

test('a step call without await before the body throws', async ({ app }) => {
  app.open();
  throw new Error('the body gave up');
});
`;

const NOT_AWAITED = /returned before expect\.poll\(\.\.\.\)\.toBe\(\.\.\.\) finished; put `await` in front of every expect\.poll call$/;

describe('expect.poll not awaited, in a run', () => {
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    ({ outcome, project } = await runProjectWithConfigFile(
      {
        'tests/a-body.e2e.ts': BODY_SUITE,
        'tests/b-hooks.e2e.ts': HOOKS_SUITE,
        'tests/b-leaky-fixture.e2e.ts': LEAKY_FIXTURE_SUITE,
        'tests/b-tidy-fixture.e2e.ts': TIDY_FIXTURE_SUITE,
        'tests/c-before-all.e2e.ts': BEFORE_ALL_SUITE,
        'tests/d-timed-out.e2e.ts': TIMED_OUT_SUITE,
        'tests/e-steps.e2e.ts': STEPS_SUITE,
      },
      { configSource: workerFakeConfigSource(1) },
    ));
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
  });

  it('produces a schema-valid report and fails the run', () => {
    assertValidReport(outcome.report);
    expect(outcome.exitCode).toBe(1);
  });

  it('fails the body that returned before its poll finished, at the line of the call', () => {
    const attempt = resultByTitle(outcome, 'an unawaited poll fails the body that started it').attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'STEP_NOT_AWAITED', phase: 'body' });
    expect(attempt.error?.message).toMatch(/^the test body /);
    expect(attempt.error?.message).toMatch(NOT_AWAITED);
    expect(attempt.error?.source?.file).toBe('tests/a-body.e2e.ts');
    // A poll is not a step: nothing is recorded for it.
    expect(attempt.steps).toEqual([]);
    expect(attempt.secondaryErrors).toEqual([]);
  });

  it('keeps the body error primary and notes the unawaited poll beside it', () => {
    const attempt = resultByTitle(outcome, 'a body error stays primary with the unawaited poll beside it').attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'ERROR', message: 'the body gave up' });
    expect(attempt.secondaryErrors.map((error) => [error.code, error.phase])).toEqual([['STEP_NOT_AWAITED', 'body']]);
  });

  it('fails a body that returns before a step it started finished with STEP_NOT_AWAITED', () => {
    const attempt = resultByTitle(outcome, 'a step call without await').attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'STEP_NOT_AWAITED', phase: 'body' });
    expect(attempt.error?.message).toContain('app.open');
    expect(attempt.error?.source?.file).toBe('tests/e-steps.e2e.ts');
    expect(attempt.steps).toHaveLength(1);
    expect(attempt.steps[0]).toMatchObject({ api: 'app.open', status: 'failed', error: { code: 'STEP_NOT_AWAITED' } });
  });

  it('keeps the body error primary and notes the un-awaited step beside it', () => {
    const attempt = resultByTitle(outcome, 'a step call without await before the body throws').attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'ERROR', message: 'the body gave up' });
    expect(attempt.secondaryErrors.map((error) => error.code)).toEqual(['STEP_NOT_AWAITED']);
    expect(attempt.steps[0]).toMatchObject({ api: 'app.open', status: 'failed', error: { code: 'STEP_NOT_AWAITED' } });
  });

  it('leaves awaited polls alone', () => {
    const failing = resultByTitle(outcome, 'an awaited failing poll fails with its own error').attempts[0]!;
    expect(failing.error?.code).toBe('ASSERTION_FAILED');
    expect(failing.error?.message).toMatch(/^expect\.poll\(\.\.\.\)\.toBe\(\.\.\.\) timed out after 100 ms/);
    expect(resultByTitle(outcome, 'an awaited passing poll passes').status).toBe('passed');
    expect(resultByTitle(outcome, 'an awaited poll in a fixture teardown passes').status).toBe('passed');
  });

  it('cancels the abandoned polls: no later test is charged with their timeouts', () => {
    for (const title of [
      'the test after them is never charged, and the abandoned poll read no more',
      'the test after the hooks is never charged',
      'the test after the beforeAll is never charged',
      'runs while the leftover body polls, and is never charged',
    ]) {
      expect(resultByTitle(outcome, title).status, title).toBe('passed');
    }
  });

  it('keeps a timed-out body to its own timeout', () => {
    const attempt = resultByTitle(outcome, 'times out, then polls from its leftover body').attempts[0]!;
    expect(attempt.error?.code).toBe('TEST_TIMEOUT');
    expect(attempt.secondaryErrors).toEqual([]);
  });

  it('fails the test whose afterEach, beforeEach, or fixture teardown left a poll running', () => {
    const afterEach = resultByTitle(outcome, 'owns the afterEach poll').attempts[0]!;
    expect(afterEach.error).toMatchObject({ code: 'STEP_NOT_AWAITED', phase: 'afterEach' });
    expect(afterEach.error?.message).toMatch(/^the afterEach hook /);
    expect(afterEach.error?.message).toMatch(NOT_AWAITED);
    expect(afterEach.error?.source?.file).toBe('tests/b-hooks.e2e.ts');

    const beforeEach = resultByTitle(outcome, 'owns the beforeEach poll').attempts[0]!;
    expect(beforeEach.error).toMatchObject({ code: 'STEP_NOT_AWAITED', phase: 'body' });

    const teardown = resultByTitle(outcome, 'owns the fixture teardown poll').attempts[0]!;
    expect(teardown.error).toMatchObject({ code: 'STEP_NOT_AWAITED', phase: 'afterEach' });
    expect(teardown.error?.message).toMatch(/^the fixture "leaky" teardown /);
  });

  it('fails a suite hook that left a poll running as that hook, never as an unhandled rejection', () => {
    expect(resultByTitle(outcome, 'runs before the afterAll poll').status).toBe('passed');
    const errors = outcome.report.run.errors;
    expect(errors.map((error) => [error.code, error.phase])).toEqual([
      ['HOOK_FAILED', 'afterAll'],
      ['HOOK_FAILED', 'beforeAll'],
    ]);
    expect(errors[0]?.message).toMatch(/^afterAll failed: the afterAll hook /);
    expect(errors[1]?.message).toMatch(/^beforeAll failed: the beforeAll hook /);
    for (const error of errors) expect(error.message).toMatch(NOT_AWAITED);
    expect(resultByTitle(outcome, 'sits under the beforeAll poll').status).not.toBe('passed');
  });
});
