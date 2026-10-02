/**
 * The TestMu AI credentials a run authenticates with: `LT_USERNAME` and
 * `LT_ACCESS_KEY` from the run's environment. agent-device's `testmu`
 * runtime reads them from the environment of the daemon that drives the
 * sessions, not from a request.
 */

const LT_USERNAME = 'LT_USERNAME';
const LT_ACCESS_KEY = 'LT_ACCESS_KEY';

export interface TestmuCredentials {
  readonly username: string;
  readonly accessKey: string;
}

/** `LT_USERNAME` and `LT_ACCESS_KEY` from the run's environment; throws naming each one that is unset or blank. */
export function testmuCredentials(env: Readonly<Record<string, string | undefined>>): TestmuCredentials {
  const username = envValue(env, LT_USERNAME);
  const accessKey = envValue(env, LT_ACCESS_KEY);
  if (username === undefined || accessKey === undefined) {
    const missing = [username === undefined ? LT_USERNAME : undefined, accessKey === undefined ? LT_ACCESS_KEY : undefined].filter((name) => name !== undefined);
    throw new Error(
      `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set; set ${LT_USERNAME} and ${LT_ACCESS_KEY} to your TestMu AI username and access key in the environment \`e2e run\` starts in`,
    );
  }
  return { username, accessKey };
}

/** The run's credentials when both are set, else `undefined`, for a call that can do without them. */
export function optionalTestmuCredentials(env: Readonly<Record<string, string | undefined>>): TestmuCredentials | undefined {
  const username = envValue(env, LT_USERNAME);
  const accessKey = envValue(env, LT_ACCESS_KEY);
  return username === undefined || accessKey === undefined ? undefined : { username, accessKey };
}

/** Daemon calls in flight inside `withDaemonCredentials`, and the values they replaced. */
let scopes = 0;
let replaced: { readonly username: string | undefined; readonly accessKey: string | undefined } | undefined;

/**
 * Runs a call to the run's daemon with the run's credentials in this
 * process's environment, which is where a daemon the call starts gets them:
 * agent-device's client starts its local daemon with `process.env` and takes
 * no environment of its own, while a run's environment can differ from
 * `process.env` (a host that passes `env`). Once no such call is in flight
 * the previous values are put back, so the credentials do not linger for
 * other child processes of a long-lived host. Every worker of the run
 * already starts with these values.
 */
export async function withDaemonCredentials<T>(credentials: TestmuCredentials | undefined, call: () => Promise<T>): Promise<T> {
  if (credentials === undefined) return call();
  if (scopes === 0) replaced = { username: process.env[LT_USERNAME], accessKey: process.env[LT_ACCESS_KEY] };
  scopes += 1;
  process.env[LT_USERNAME] = credentials.username;
  process.env[LT_ACCESS_KEY] = credentials.accessKey;
  try {
    return await call();
  } finally {
    scopes -= 1;
    if (scopes === 0 && replaced !== undefined) {
      restore(LT_USERNAME, replaced.username);
      restore(LT_ACCESS_KEY, replaced.accessKey);
      replaced = undefined;
    }
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A non-empty variable from the run's environment, trimmed, or `undefined`. */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}
