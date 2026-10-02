/**
 * `testmu()` pruning the state directories earlier runs left under
 * `stateDir`: once per provider, only run directories older than a day,
 * never the current run's, and never failing the lease.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceRequest } from '@e2e-dev/mobile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testmu, type TestmuOptions } from '../../src/index.ts';

vi.mock('agent-device', () => ({
  createAgentDeviceClient: () => ({
    leases: {
      allocate: async (options: Record<string, unknown>) => ({ leaseId: 'lease-1', tenantId: options['tenant'], runId: options['runId'] }),
      heartbeat: async () => ({}),
      release: async () => ({ released: true }),
    },
  }),
}));

const options: TestmuOptions = { device: 'Galaxy S22 Ultra 5G', osVersion: '14', app: 'lt://APP1', stateDir: 'state' };
const CURRENT_RUN = '01a0fc76-002f-736c-991a-fa4778d0543e';
const OLD_RUN = '01a0e000-0000-7000-8000-000000000001';
const RECENT_RUN = '01a0e000-0000-7000-8000-000000000002';
/** A file named like a run: only directories are pruned. */
const RUN_FILE = '01a0e000-0000-7000-8000-000000000003';
const HOUR = 60 * 60_000;

let root: string;
let base: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'testmu-prune-'));
  base = join(root, 'state');
  mkdirSync(base);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A directory under the state directory, last modified `ageMs` ago, with a daemon log in it. */
function runDir(name: string, ageMs: number): void {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'daemon.log'), 'log');
  const time = new Date(Date.now() - ageMs);
  utimesSync(dir, time, time);
}

function request(overrides: Partial<DeviceRequest> = {}): DeviceRequest {
  return {
    platform: 'android',
    runId: CURRENT_RUN,
    targetName: 'android',
    slot: 0,
    slots: 1,
    projectRoot: root,
    agentDeviceVersion: '0.21.18',
    env: { LT_USERNAME: 'ada', LT_ACCESS_KEY: 'lt-key' },
    signal: new AbortController().signal,
    log: () => undefined,
    ...overrides,
  };
}

describe('testmu() state directory pruning', () => {
  it("removes earlier runs' directories older than a day, and keeps the current run's, recent ones, and anything not named like a run", async () => {
    runDir(OLD_RUN, 25 * HOUR);
    runDir(RECENT_RUN, 23 * HOUR);
    runDir(CURRENT_RUN, 48 * HOUR);
    runDir('notes', 48 * HOUR);
    writeFileSync(join(base, RUN_FILE), 'a file');
    utimesSync(join(base, RUN_FILE), new Date(Date.now() - 48 * HOUR), new Date(Date.now() - 48 * HOUR));
    await testmu(options).acquire(request());
    expect(readdirSync(base).toSorted()).toEqual([CURRENT_RUN, RECENT_RUN, RUN_FILE, 'notes'].toSorted());
  });

  it('prunes once per provider, on its first acquire', async () => {
    const provider = testmu(options);
    await provider.acquire(request());
    runDir(OLD_RUN, 25 * HOUR);
    await provider.acquire(request({ slot: 1, slots: 2 }));
    expect(existsSync(join(base, OLD_RUN))).toBe(true);
  });

  it('leases a device when there is nothing to prune or pruning fails', async () => {
    await expect(testmu({ ...options, stateDir: 'missing' }).acquire(request())).resolves.toMatchObject({ id: 'lease-1' });
    writeFileSync(join(root, 'plain-file'), 'not a directory');
    await expect(testmu({ ...options, stateDir: 'plain-file' }).acquire(request())).resolves.toMatchObject({ id: 'lease-1' });
  });
});
