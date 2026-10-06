import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

/**
 * A host process of its own: vitest's handlers would see the stray errors
 * first, and the point is what an in-process run does to a host that has
 * none. It runs the fixture through a `rawConfig` on a noop engine with
 * `engineMembers`, prints what came back and which process listeners it left
 * behind.
 */
const hostScript = (engineMembers: string) => `import { defineEngine } from 'e2e/engine';
const { run } = await import(new URL('../../../dist/run/runner.js', import.meta.url).href);
const listeners = () => [process.listenerCount('unhandledRejection'), process.listenerCount('uncaughtException')];
const before = listeners();
const engine = defineEngine({ name: 'noop', version: '1', spiVersion: 1, ${engineMembers} });
const outcome = await run({
  cwd: process.cwd(),
  rawConfig: { targets: [{ name: 'headless', platform: 'test', engine }] },
  env: { ...process.env, CI: '' },
  quiet: true,
});
console.log(JSON.stringify({
  results: Object.fromEntries(outcome.results.map((r) => [r.test.title, [r.status, r.attempts[0]?.error?.code ?? r.skip?.cause, r.attempts[0]?.error?.message]])),
  exitCode: outcome.exitCode,
  runErrors: outcome.report.run.errors.map((e) => [e.code, e.message]),
  listeners: { before, after: listeners() },
}));
`;

/** Runs `tests` in-process inside a fresh host process. */
function runInHost(tests: Readonly<Record<string, string>>, engineMembers = '') {
  const project = createProject({ ...tests, 'host.mjs': hostScript(engineMembers) });
  projects.push(project);
  const host = spawnSync(process.execPath, ['host.mjs'], {
    cwd: project.dir,
    env: { ...process.env, E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(host.stderr).toBe('');
  expect(host.status).toBe(0);
  return JSON.parse(host.stdout.trim().split('\n').at(-1)!) as {
    results: Record<string, [string, string | null, string | null]>;
    exitCode: number;
    runErrors: [string, string][];
    listeners: { before: number[]; after: number[] };
  };
}

describe('an in-process run', () => {
  it('fails the test that left a rejection unhandled, as a worker process does, and leaves the host its own handlers', () => {
    const outcome = runInHost({
      'tests/stray.e2e.ts': `import { test } from 'e2e';

test('leaves a rejection behind', async () => {
  void Promise.reject(new Error('boom'));
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test('runs after the rejection', async () => {});
`,
    });
    expect(outcome.results).toEqual({
      'leaves a rejection behind': ['failed', 'ERROR', 'boom'],
      'runs after the rejection': ['passed', null, null],
    });
    expect(outcome.runErrors).toEqual([]);
    expect(outcome.listeners).toEqual({ before: [0, 0], after: [0, 0] });
  });

  it('records a rejection between tests against the last test that finished', () => {
    const outcome = runInHost({
      'tests/a-leaks.e2e.ts': `import { test } from 'e2e';

test('finishes before the leak', async () => {});

test.afterAll(async () => {
  void Promise.reject(new Error('late'));
  await new Promise((resolve) => setTimeout(resolve, 100));
});
`,
      'tests/b-next.e2e.ts': `import { test } from 'e2e';

test('runs afterwards', async () => {});
`,
    });
    expect(outcome.results['finishes before the leak']?.[0]).toBe('passed');
    expect(outcome.results['runs afterwards']?.[0]).toBe('passed');
    expect(outcome.runErrors).toHaveLength(1);
    expect(outcome.runErrors[0]?.[0]).toBe('UNHANDLED_REJECTION');
    expect(outcome.runErrors[0]?.[1]).toContain('late');
  });

  it('ends the worker on an uncaught exception, as a crashed worker process, instead of crashing the host', () => {
    const outcome = runInHost({
      'tests/throws.e2e.ts': `import { test } from 'e2e';

test('throws off the stack', async () => {
  setTimeout(() => {
    throw new Error('boom-uncaught');
  });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
});

test('never starts', async () => {});
`,
    });
    expect(outcome.results).toEqual({
      'throws off the stack': ['failed', 'WORKER_CRASH', expect.any(String)],
      'never starts': ['skipped', 'infrastructure-unavailable', null],
    });
    expect(outcome.runErrors).toEqual([['ERROR', 'boom-uncaught']]);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.listeners).toEqual({ before: [0, 0], after: [0, 0] });
  });

  it('still reports what disposing the engine failed with after a fatal', () => {
    const outcome = runInHost(
      {
        'tests/throws.e2e.ts': `import { test } from 'e2e';

test('throws off the stack', async () => {
  setTimeout(() => {
    throw new Error('boom-uncaught');
  });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
});
`,
      },
      `dispose: () => { throw new Error('dispose-failed'); },`,
    );
    expect(outcome.runErrors).toEqual([
      ['ERROR', 'boom-uncaught'],
      ['ENGINE_FAILURE', expect.stringContaining('dispose-failed')],
    ]);
  });

  it('ends the worker on a rejection before any test has finished in it', () => {
    const outcome = runInHost({
      'tests/early.e2e.ts': `import { test } from 'e2e';

test.beforeAll(async () => {
  void Promise.reject(new Error('early'));
  await new Promise((resolve) => setTimeout(resolve, 500));
});

test('is on its way when it surfaces', async () => {});

test('follows in the same file', async () => {});
`,
    });
    expect(outcome.results).toEqual({
      'is on its way when it surfaces': ['failed', 'WORKER_CRASH', expect.any(String)],
      'follows in the same file': ['skipped', 'infrastructure-unavailable', null],
    });
    expect(outcome.runErrors).toEqual([['ERROR', 'early']]);
    expect(outcome.exitCode).toBe(3);
  });
});
