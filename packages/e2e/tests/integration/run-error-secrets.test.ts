/**
 * A run-level error, such as a test file that throws while it is collected or
 * a suite hook that fails, is redacted with the config's static secrets even
 * when no session ever learned them.
 */

import { describe, expect, it } from 'vitest';
import { runProjectWithConfigFile } from '../helpers/run-project.ts';

const SECRET = 'run-error-secret-Qx7W2p';
const MARKER = '<secret:probe>';

const CONFIG = `import type { E2EConfig } from 'e2e';
import { defineEngine } from 'e2e/engine';

const node = { ref: { id: 'n1', revision: '' }, role: 'button', name: 'Go', states: { hidden: false } };

export default {
  targets: [{ name: 'fake', platform: 'custom', engine: defineEngine({
    name: 'fake', version: '1.0.0', spiVersion: 1,
    async observe() { return { location: 'app://fake/Home', root: node, viewport: { width: 100, height: 100 } }; },
    async locate() { return [node]; },
  }) }],
  workers: 1,
  cache: 'off',
  secrets: { probe: ${JSON.stringify(SECRET)} },
} satisfies E2EConfig;
`;

const THROWS_AT_COLLECTION = `import { test } from 'e2e';

throw new Error('the app echoed ${SECRET}');

test('never runs', async () => {});
`;

const THROWS_IN_BEFORE_ALL = `import { test } from 'e2e';

test.beforeAll(() => {
  throw new Error('the app echoed ${SECRET}');
});

test('never runs', async () => {});
`;

describe('a run-level error', () => {
  it.each([
    ['a collection failure', THROWS_AT_COLLECTION],
    ['a beforeAll failure', THROWS_IN_BEFORE_ALL],
  ])('redacts the config secrets from %s', async (_name, source) => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/boom.e2e.ts': source },
      { appUrl: 'http://127.0.0.1:9/', configSource: CONFIG },
    );
    try {
      const messages = outcome.report.run.errors.map((error) => error.message).join('\n');
      expect(messages).toContain(MARKER);
      expect(JSON.stringify(outcome.report)).not.toContain(SECRET);
    } finally {
      project.cleanup();
    }
  });
});
