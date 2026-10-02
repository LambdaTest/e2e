/**
 * TestMu AI's hosted Android emulators, iOS simulators, and real devices as a
 * `DeviceProvider` for the mobile engine, through agent-device's `testmu`
 * cloud provider: the provider allocates agent-device leases, and the daemon
 * holding them runs each session over TestMu AI's Appium hub.
 */

import { isAbsolute, resolve } from 'node:path';
import type { DeviceLease, DeviceProvider, DeviceRequest } from '@e2e-dev/mobile';
import { createAgentDeviceClient } from 'agent-device';
import { ConfigurationError, rejectUnknownKeys } from 'e2e/engine';
import { shareWithDaemon, testmuCredentials } from './credentials.ts';

/** agent-device's name for TestMu AI, as the lease provider and the tenant. */
const PROVIDER = 'testmu';

/** Where each run's daemon keeps its state, under the project root. */
const DEFAULT_STATE_DIR = '.e2e/testmu';

/** The dashboard project sessions are grouped under when `project` is absent. */
const DEFAULT_PROJECT = 'e2e';

const DEVICE_TYPES: ReadonlySet<string> = new Set(['virtual', 'real']);

/** Every option `testmu()` takes, kept equal to `TestmuOptions` by the compiler. */
const OPTION_KEYS: readonly string[] = Object.keys({
  device: true,
  osVersion: true,
  app: true,
  deviceType: true,
  project: true,
  build: true,
  sessionName: true,
  stateDir: true,
} satisfies Record<keyof TestmuOptions, true>);

/** What `testmu()` takes: the device, its OS version, and the app TestMu AI installs on it. */
export interface TestmuOptions {
  /** Device name exactly as TestMu AI's catalog lists it: `Galaxy S22 Ultra 5G`, `iPhone 16`. */
  readonly device: string;
  /** OS version exactly as the catalog lists it for that device: `14` on Android, `18.0` on a virtual iOS device, `18` on a real one. */
  readonly osVersion: string;
  /**
   * The build TestMu AI installs on every session: an `lt://` app id, an
   * `https` URL, or a local path, resolved against the project root and
   * uploaded when the session starts.
   */
  readonly app: string;
  /** `'virtual'` (default) for an emulator or simulator, `'real'` for a real device. */
  readonly deviceType?: 'virtual' | 'real' | undefined;
  /** Dashboard project the sessions are grouped under. Defaults to `e2e`. */
  readonly project?: string | undefined;
  /** Dashboard build the sessions are grouped under. Defaults to the run id. */
  readonly build?: string | undefined;
  /** Name of every session on the dashboard; absent, TestMu AI names it. */
  readonly sessionName?: string | undefined;
  /** Directory for the agent-device daemon each run starts, relative to the project root. Defaults to `.e2e/testmu`. */
  readonly stateDir?: string | undefined;
}

type LeaseBackend = 'ios-instance' | 'android-instance';

/** The lease scope agent-device resolves a leased device by, as `leases.allocate` granted it. */
interface LeaseScope {
  readonly tenant: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly leaseBackend: LeaseBackend;
  readonly leaseProvider: string;
}

/** A lease's daemon and scope: what releasing it needs. */
interface LeaseHandle {
  readonly stateDir: string;
  readonly scope: LeaseScope;
}

/**
 * TestMu AI devices for `mobile({ device: testmu({ device, osVersion, app }) })`:
 * one hosted device per worker slot, leased when the run starts and released
 * when it ends. Each lease comes from an agent-device daemon the provider
 * starts for the run under `stateDir`; the worker's first command starts the
 * TestMu AI session, which installs `app`, and releasing the lease ends it.
 * It authenticates with `LT_USERNAME` and `LT_ACCESS_KEY` from the run's
 * environment, and needs an agent-device with the `testmu` provider.
 */
export function testmu(options: TestmuOptions): DeviceProvider {
  rejectUnknownKeys('testmu()', options, OPTION_KEYS);
  for (const key of ['device', 'osVersion', 'app'] as const) {
    const value: unknown = options[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConfigurationError('INVALID_CONFIG', `testmu: \`${key}\` is required, as a non-empty string`);
    }
  }
  const deviceType = options.deviceType ?? 'virtual';
  if (!DEVICE_TYPES.has(deviceType)) {
    throw new ConfigurationError('INVALID_CONFIG', `testmu: \`deviceType\` must be 'virtual' or 'real', not ${JSON.stringify(deviceType)}`);
  }
  const { device, osVersion, app, project, build, sessionName } = options;
  /** One release per lease, shared by every caller: the engine's, and `acquire`'s own after a failure. */
  const releases = new Map<string, Promise<void>>();
  const release = (id: string, handle: LeaseHandle): Promise<void> => {
    let pending = releases.get(id);
    if (pending === undefined) {
      pending = releaseLease(handle);
      releases.set(id, pending);
      // A failed release may be tried again.
      pending.catch(() => releases.delete(id));
    }
    return pending;
  };
  return {
    name: PROVIDER,
    async acquire(request: DeviceRequest): Promise<DeviceLease> {
      if (request.appPath !== undefined) throw new Error("TestMu AI installs the app from `app`; leave the target's `app.appPath` out");
      shareWithDaemon(testmuCredentials(request.env));
      if (request.signal.aborted) throw new Error('cancelled before a lease was allocated');
      const stateDir = resolve(request.projectRoot, options.stateDir ?? DEFAULT_STATE_DIR, request.runId);
      const leaseBackend: LeaseBackend = request.platform === 'ios' ? 'ios-instance' : 'android-instance';
      const selectors = {
        platform: request.platform,
        target: 'mobile' as const,
        device,
        providerOsVersion: osVersion,
        providerApp: appSource(app, request.projectRoot),
        providerDeviceType: deviceType,
        providerProject: project ?? DEFAULT_PROJECT,
        providerBuild: build ?? request.runId,
        ...(sessionName === undefined ? {} : { providerSessionName: sessionName }),
      };
      // Not cancellable: the daemon may grant the lease after an interrupt, and only a lease this returns or releases is ever released.
      const granted = await createAgentDeviceClient({ stateDir, session: `lease-${request.slot}` }).leases.allocate({
        tenant: PROVIDER,
        runId: request.runId,
        leaseBackend,
        leaseProvider: PROVIDER,
        ...selectors,
      });
      const scope: LeaseScope = { tenant: granted.tenantId, runId: granted.runId, leaseId: granted.leaseId, leaseBackend, leaseProvider: PROVIDER };
      try {
        if (request.signal.aborted) throw new Error('cancelled');
        request.log(`lease ${scope.leaseId}: ${device}, ${request.platform} ${osVersion} (${deviceType}); the session starts on the first command`);
        // The worker's client is created with these fields: the scope picks the lease, and the selectors start the session.
        return { id: scope.leaseId, client: { stateDir, ...scope, ...selectors } };
      } catch (cause) {
        // The engine releases only leases `acquire` returned.
        const outcome = await release(scope.leaseId, { stateDir, scope }).then(
          () => 'released it',
          (releaseCause: unknown) => `releasing it failed (${messageOf(releaseCause)})`,
        );
        throw new Error(`lease ${scope.leaseId} was not handed to the run: ${messageOf(cause)}; ${outcome}`, { cause });
      }
    },
    async release(lease: DeviceLease): Promise<void> {
      const handle = leaseHandle(lease);
      if (handle === undefined) throw new Error(`lease ${lease.id} carries no agent-device lease scope to release`);
      await release(lease.id, handle);
    },
  };
}

/** Releases a lease through the daemon that granted it, which ends its TestMu AI session. A lease the daemon no longer knows counts as released. */
async function releaseLease({ stateDir, scope }: LeaseHandle): Promise<void> {
  await createAgentDeviceClient({ stateDir, session: 'release' }).leases.release(scope);
}

/** `app` as the daemon reads it: an `lt://` id or URL as written, a local path resolved against the project root, never the daemon's working directory. */
function appSource(app: string, projectRoot: string): string {
  if (isAbsolute(app) || /^[a-z][a-z0-9+.-]*:\/\//i.test(app)) return app;
  return resolve(projectRoot, app);
}

/** The daemon and scope `acquire` put on a lease's `client`, when they are there. */
function leaseHandle(lease: DeviceLease): LeaseHandle | undefined {
  const client = lease.client as Record<string, unknown> | undefined;
  if (client === undefined) return undefined;
  const { stateDir, tenant, runId, leaseId, leaseBackend, leaseProvider } = client;
  if (
    typeof stateDir !== 'string' ||
    typeof tenant !== 'string' ||
    typeof runId !== 'string' ||
    typeof leaseId !== 'string' ||
    (leaseBackend !== 'ios-instance' && leaseBackend !== 'android-instance') ||
    typeof leaseProvider !== 'string'
  ) {
    return undefined;
  }
  return { stateDir, scope: { tenant, runId, leaseId, leaseBackend, leaseProvider } };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
