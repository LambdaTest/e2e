/**
 * `testmu()` against a stubbed agent-device client: the options it refuses,
 * the lease it allocates and hands the worker, the credentials it reads and
 * shares with the daemon, and the release on every exit path.
 */

import { join } from 'node:path';
import type { DeviceLease, DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testmu, type TestmuOptions } from '../../src/index.ts';

interface ClientCall {
  readonly config: Record<string, unknown>;
  readonly operation: 'allocate' | 'release';
  readonly options: Record<string, unknown>;
}

const daemon = {
  calls: [] as ClientCall[],
  /** Runs inside `allocate`, before it answers. */
  onAllocate: undefined as (() => void) | undefined,
  allocateError: undefined as Error | undefined,
  /** Errors `release` answers with, in order, before it succeeds. */
  releaseErrors: [] as Error[],
};

vi.mock('agent-device', () => ({
  createAgentDeviceClient: (config: Record<string, unknown>) => ({
    leases: {
      allocate: async (options: Record<string, unknown>) => {
        daemon.calls.push({ config, operation: 'allocate', options });
        daemon.onAllocate?.();
        if (daemon.allocateError !== undefined) throw daemon.allocateError;
        return { leaseId: `lease-${daemon.calls.length}`, tenantId: options['tenant'], runId: options['runId'], backend: options['leaseBackend'], leaseProvider: options['leaseProvider'] };
      },
      release: async (options: Record<string, unknown>) => {
        daemon.calls.push({ config, operation: 'release', options });
        const error = daemon.releaseErrors.shift();
        if (error !== undefined) throw error;
        return { released: true };
      },
    },
  }),
}));

const ROOT = join('/', 'work', 'shop');
const env = { LT_USERNAME: 'ada', LT_ACCESS_KEY: 'lt-key' };
const options: TestmuOptions = { device: 'Galaxy S22 Ultra 5G', osVersion: '14', app: 'https://example.com/app.apk' };
const saved = { LT_USERNAME: process.env['LT_USERNAME'], LT_ACCESS_KEY: process.env['LT_ACCESS_KEY'] };

beforeEach(() => {
  Object.assign(daemon, { calls: [], onAllocate: undefined, allocateError: undefined, releaseErrors: [] });
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function request(overrides: Partial<DeviceRequest> = {}): DeviceRequest & { lines: string[] } {
  const lines: string[] = [];
  return {
    platform: 'android',
    runId: 'run-1',
    targetName: 'android',
    slot: 0,
    slots: 2,
    app: 'com.example.app',
    agentDeviceVersion: '0.21.18',
    projectRoot: ROOT,
    env,
    signal: new AbortController().signal,
    log: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

const context: DeviceReleaseContext = { runId: 'run-1', targetName: 'android', env, signal: new AbortController().signal, log: () => undefined };

const operations = () => daemon.calls.map((call) => call.operation);

describe('testmu()', () => {
  it('is a device provider named testmu that leaves recording to agent-device', () => {
    const provider = testmu(options);
    expect(provider.name).toBe('testmu');
    expect(provider.record).toBeUndefined();
  });

  it('allocates an Android lease from a daemon under the project root, with the device selectors and dashboard labels', async () => {
    await testmu(options).acquire(request({ slot: 1 }));
    expect(daemon.calls).toEqual([
      {
        config: { stateDir: join(ROOT, '.e2e', 'testmu', 'run-1'), session: 'lease-1' },
        operation: 'allocate',
        options: {
          tenant: 'testmu',
          runId: 'run-1',
          leaseBackend: 'android-instance',
          leaseProvider: 'testmu',
          platform: 'android',
          target: 'mobile',
          device: 'Galaxy S22 Ultra 5G',
          providerOsVersion: '14',
          providerApp: 'https://example.com/app.apk',
          providerDeviceType: 'virtual',
          providerProject: 'e2e',
          providerBuild: 'run-1',
        },
      },
    ]);
  });

  it('allocates an iOS lease on a real device with its own project, build, session name, and state directory', async () => {
    await testmu({ device: 'iPhone 16', osVersion: '18', app: 'lt://APP123', deviceType: 'real', project: 'shop', build: 'nightly', sessionName: 'checkout', stateDir: 'tmp/devices' }).acquire(
      request({ platform: 'ios' }),
    );
    expect(daemon.calls[0]?.config['stateDir']).toBe(join(ROOT, 'tmp', 'devices', 'run-1'));
    expect(daemon.calls[0]?.options).toMatchObject({
      leaseBackend: 'ios-instance',
      platform: 'ios',
      device: 'iPhone 16',
      providerOsVersion: '18',
      providerApp: 'lt://APP123',
      providerDeviceType: 'real',
      providerProject: 'shop',
      providerBuild: 'nightly',
      providerSessionName: 'checkout',
    });
  });

  it('resolves a local build against the project root, never the working directory', async () => {
    await testmu({ ...options, app: 'build/app.apk' }).acquire(request());
    expect(daemon.calls[0]?.options['providerApp']).toBe(join(ROOT, 'build', 'app.apk'));
    await testmu({ ...options, app: join('/', 'builds', 'app.apk') }).acquire(request());
    expect(daemon.calls[1]?.options['providerApp']).toBe(join('/', 'builds', 'app.apk'));
  });

  it('hands the worker the lease scope and the selectors as JSON client configuration', async () => {
    const req = request();
    const lease = await testmu(options).acquire(req);
    expect(lease).toEqual({
      id: 'lease-1',
      client: {
        stateDir: join(ROOT, '.e2e', 'testmu', 'run-1'),
        tenant: 'testmu',
        runId: 'run-1',
        leaseId: 'lease-1',
        leaseBackend: 'android-instance',
        leaseProvider: 'testmu',
        platform: 'android',
        target: 'mobile',
        device: 'Galaxy S22 Ultra 5G',
        providerOsVersion: '14',
        providerApp: 'https://example.com/app.apk',
        providerDeviceType: 'virtual',
        providerProject: 'e2e',
        providerBuild: 'run-1',
      },
    });
    const json = JSON.stringify(lease);
    expect(JSON.parse(json)).toEqual(lease);
    expect(Buffer.byteLength(json)).toBeLessThan(1024);
    expect(json).not.toContain('lt-key');
    expect(req.lines).toEqual(['lease lease-1: Galaxy S22 Ultra 5G, android 14 (virtual); the session starts on the first command']);
  });

  it('shares the run\'s credentials with the daemon it starts', async () => {
    delete process.env['LT_USERNAME'];
    process.env['LT_ACCESS_KEY'] = 'stale';
    daemon.onAllocate = () => expect([process.env['LT_USERNAME'], process.env['LT_ACCESS_KEY']]).toEqual(['ada', 'lt-key']);
    await testmu(options).acquire(request({ env: { LT_USERNAME: ' ada ', LT_ACCESS_KEY: 'lt-key' } }));
    expect(operations()).toEqual(['allocate']);
  });

  it.each([
    [{}, 'LT_USERNAME and LT_ACCESS_KEY are not set'],
    [{ LT_USERNAME: 'ada' }, 'LT_ACCESS_KEY is not set'],
    [{ LT_USERNAME: '  ', LT_ACCESS_KEY: 'lt-key' }, 'LT_USERNAME is not set'],
  ])('fails before any daemon starts without credentials in the run\'s environment (%j)', async (runEnv, message) => {
    process.env['LT_USERNAME'] = 'from-the-runner';
    process.env['LT_ACCESS_KEY'] = 'from-the-runner';
    await expect(testmu(options).acquire(request({ env: runEnv }))).rejects.toThrow(
      `${message}; set LT_USERNAME and LT_ACCESS_KEY to your TestMu AI username and access key in the environment \`e2e run\` starts in`,
    );
    expect(daemon.calls).toEqual([]);
  });

  it("refuses the target's app.appPath, since TestMu AI installs `app`", async () => {
    await expect(testmu(options).acquire(request({ appPath: join(ROOT, 'build', 'app.apk') }))).rejects.toThrow(
      "TestMu AI installs the app from `app`; leave the target's `app.appPath` out",
    );
    expect(daemon.calls).toEqual([]);
  });

  it('allocates nothing once the run is interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(testmu(options).acquire(request({ signal: controller.signal }))).rejects.toThrow('cancelled before a lease was allocated');
    expect(daemon.calls).toEqual([]);
  });

  it('releases a lease granted after an interrupt instead of handing it over', async () => {
    const controller = new AbortController();
    daemon.onAllocate = () => controller.abort();
    const req = request({ signal: controller.signal });
    await expect(testmu(options).acquire(req)).rejects.toThrow('lease lease-1 was not handed to the run: cancelled; released it');
    expect(daemon.calls[1]).toEqual({
      config: { stateDir: join(ROOT, '.e2e', 'testmu', 'run-1'), session: 'release' },
      operation: 'release',
      options: { tenant: 'testmu', runId: 'run-1', leaseId: 'lease-1', leaseBackend: 'android-instance', leaseProvider: 'testmu' },
    });
    expect(req.lines).toEqual([]);
  });

  it('releases a granted lease when handing it over fails, and says when that release failed too', async () => {
    daemon.releaseErrors = [new Error('daemon gone')];
    const req = request({
      log: () => {
        throw new Error('reporter closed');
      },
    });
    await expect(testmu(options).acquire(req)).rejects.toThrow('lease lease-1 was not handed to the run: reporter closed; releasing it failed (daemon gone)');
    expect(operations()).toEqual(['allocate', 'release']);
  });

  it('passes an allocation failure through with nothing to release', async () => {
    daemon.allocateError = new Error('unknown lease provider testmu');
    await expect(testmu(options).acquire(request())).rejects.toThrow('unknown lease provider testmu');
    expect(operations()).toEqual(['allocate']);
  });

  it('releases a lease through the daemon that granted it, once however often it is asked', async () => {
    const provider = testmu(options);
    const lease = await provider.acquire(request());
    await Promise.all([provider.release(lease, context), provider.release(lease, context)]);
    await provider.release(lease, context);
    expect(daemon.calls.slice(1)).toEqual([
      {
        config: { stateDir: join(ROOT, '.e2e', 'testmu', 'run-1'), session: 'release' },
        operation: 'release',
        options: { tenant: 'testmu', runId: 'run-1', leaseId: 'lease-1', leaseBackend: 'android-instance', leaseProvider: 'testmu' },
      },
    ]);
  });

  it('releases from the lease alone, after a round trip through JSON', async () => {
    const lease = JSON.parse(JSON.stringify(await testmu(options).acquire(request({ platform: 'ios' })))) as DeviceLease;
    await testmu(options).release(lease, context);
    expect(daemon.calls[1]?.options).toEqual({ tenant: 'testmu', runId: 'run-1', leaseId: 'lease-1', leaseBackend: 'ios-instance', leaseProvider: 'testmu' });
  });

  it('tries a release again after one failed', async () => {
    daemon.releaseErrors = [new Error('daemon busy')];
    const provider = testmu(options);
    const lease = await provider.acquire(request());
    await expect(provider.release(lease, context)).rejects.toThrow('daemon busy');
    await provider.release(lease, context);
    expect(operations()).toEqual(['allocate', 'release', 'release']);
  });

  it('refuses to release a lease without an agent-device scope', async () => {
    await expect(testmu(options).release({ id: 'other', client: { stateDir: '/tmp/x' } }, context)).rejects.toThrow('lease other carries no agent-device lease scope to release');
    expect(daemon.calls).toEqual([]);
  });

  it('rejects an option it does not take with INVALID_CONFIG, naming the nearest one', () => {
    expect(() => testmu({ ...options, osVerison: '14' } as unknown as TestmuOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('osVersion') }));
  });

  it.each(['device', 'osVersion', 'app'] as const)('requires `%s` with INVALID_CONFIG', (key) => {
    expect(() => testmu({ ...options, [key]: ' ' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: `testmu: \`${key}\` is required, as a non-empty string` }));
    const { [key]: _, ...rest } = options;
    expect(() => testmu(rest as TestmuOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('refuses a device type other than virtual or real', () => {
    expect(() => testmu({ ...options, deviceType: 'emulator' as 'virtual' })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: 'testmu: `deviceType` must be \'virtual\' or \'real\', not "emulator"' }),
    );
  });
});
