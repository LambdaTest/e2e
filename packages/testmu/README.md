# @e2e-dev/testmu

[TestMu AI](https://www.lambdatest.com) (formerly LambdaTest) for [`e2e`](https://www.npmjs.com/package/e2e):
`mobile({ device: testmu({ device, osVersion, app }) })` runs a mobile target on
TestMu AI's hosted Android emulators, iOS simulators, and real devices.

## Install

```bash
npm install --save-dev @e2e-dev/testmu agent-device@<version>
```

The provider drives TestMu AI through agent-device's `testmu` cloud
provider, so the project needs an agent-device that includes it, and
`@e2e-dev/mobile` must use that same agent-device: override its pin (npm and
bun `overrides`, pnpm `overrides` in `pnpm-workspace.yaml`). No published
agent-device release includes the `testmu` provider yet; `<version>` is the
first one that does. The peer range only excludes the releases known to lack
it.

## Usage

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { testmu } from '@e2e-dev/testmu';

export default {
  targets: [
    {
      engine: mobile({
        platform: 'android',
        device: testmu({ device: 'Galaxy S22 Ultra 5G', osVersion: '14', app: 'https://example.com/app.apk' }),
      }),
      app: { bundleId: 'com.example.app' },
    },
  ],
  workers: 2,
} satisfies E2EConfig;
```

It authenticates with `LT_USERNAME` and `LT_ACCESS_KEY` from the run's
environment. Each worker slot leases one device from an agent-device daemon
the provider starts for the run; the worker's first command starts the
TestMu AI session, which installs `app`, and the lease is released when the
run ends, which ends the session.

- `device` and `osVersion` must match TestMu AI's catalog exactly: `18.0`
  for a virtual iOS device, `18` for a real one, `14` on Android.
- `app` is an `lt://` app id, an `https` URL, or a local path resolved
  against the project root. Keep the target's `app.bundleId` and leave
  `app.appPath` out.
- `deviceType: 'real'` picks a real device (default `'virtual'`).
- `project` (default `e2e`), `build` (default the run id), and `sessionName`
  label the sessions on the dashboard.
- `stateDir` (default `.e2e/testmu`) holds each run's daemon.

Sessions run over TestMu AI's Appium hub, so agent-device's device settings,
system alerts, recording, device logs, and port reverse are not available
there. TestMu AI records every session itself.

Full documentation lives at [e2e.tester.army/docs/integrations/testmu](https://e2e.tester.army/docs/integrations/testmu).

## License

Apache-2.0
