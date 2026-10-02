/**
 * TestMu AI's mobile automation sessions API over `fetch`, the one
 * agent-device's `testmu` provider reads session artifacts from: finds a
 * session by its build and name, and reads the URL of its video.
 */

import type { TestmuCredentials } from './credentials.ts';

/** The API's base, as agent-device's `TESTMU_API_ENDPOINT` sets it. */
const DEFAULT_API_ENDPOINT = 'https://mobile-api.lambdatest.com/mobile-automation/api/v1';

const REQUEST_TIMEOUT_MS = 15_000;

/** Sessions the list asks for at once. */
const PAGE_SIZE = 50;

/** Pages the lookup reads before it gives up on a build: the list is newest first, so the session is near the top. */
const MAX_PAGES = 10;

/** A session the recording covers, as the lease named it. */
export interface SessionRef {
  readonly build: string;
  readonly sessionName: string;
}

/** The sessions API at `TESTMU_API_ENDPOINT` from the run's environment, else TestMu AI's own; throws when the override is not an http(s) URL. */
export function testmuApiEndpoint(env: Readonly<Record<string, string | undefined>>): string {
  const override = env['TESTMU_API_ENDPOINT']?.trim();
  if (override === undefined || override === '') return DEFAULT_API_ENDPOINT;
  if (!URL.canParse(override) || !/^https?:$/.test(new URL(override).protocol)) throw new Error('TESTMU_API_ENDPOINT is not an http(s) URL');
  return override.replace(/\/+$/, '');
}

/**
 * The video URL of the newest session named `sessionName` in `build`: the
 * list finds the session's `test_id`, and its details carry `video_url`.
 * Every request is bounded by `REQUEST_TIMEOUT_MS` and `signal`. Errors name
 * the build and the session, never the credentials or a URL.
 */
export async function sessionVideoUrl(endpoint: string, credentials: TestmuCredentials, { build, sessionName }: SessionRef, signal: AbortSignal): Promise<string> {
  const auth = `Basic ${Buffer.from(`${credentials.username}:${credentials.accessKey}`).toString('base64')}`;
  const id = await findSession(endpoint, auth, { build, sessionName }, signal);
  const what = `TestMu AI session ${id} (${JSON.stringify(sessionName)}, build ${JSON.stringify(build)})`;
  const body = await getJson(new URL(`${endpoint}/sessions/${encodeURIComponent(id)}`), auth, signal, `${what} details`);
  const details = asRecord(body['data']);
  const videoUrl = details?.['video_url'];
  if (typeof videoUrl !== 'string' || !isHttpUrl(videoUrl)) throw new Error(`${what} reports no video URL`);
  return videoUrl;
}

/** The `test_id` of the newest session named `sessionName` in `build`, reading the list a page at a time. */
async function findSession(endpoint: string, auth: string, { build, sessionName }: SessionRef, signal: AbortSignal): Promise<string> {
  const what = `TestMu AI session lookup for build ${JSON.stringify(build)}`;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${endpoint}/sessions`);
    url.searchParams.set('build', build);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('offset', String(page * PAGE_SIZE));
    const body = await getJson(url, auth, signal, what);
    // An empty page comes back as `data: null`.
    const rows = body['data'] ?? [];
    if (!Array.isArray(rows)) throw new Error(`${what} failed: no session list in the response`);
    for (const row of rows) {
      const { name, test_id: id } = asRecord(row) ?? {};
      if (name === sessionName && typeof id === 'string' && id !== '') return id;
    }
    if (rows.length < PAGE_SIZE) break;
  }
  throw new Error(`TestMu AI has no session named ${JSON.stringify(sessionName)} in build ${JSON.stringify(build)}`);
}

/** One authenticated GET answered with a JSON object; anything else throws, as `what`, with the HTTP status and the API's message. */
async function getJson(url: URL, auth: string, signal: AbortSignal, what: string): Promise<Record<string, unknown>> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.any([signal, timeout.signal]) });
    text = await response.text();
  } catch (cause) {
    if (signal.aborted) throw new Error(`${what} cancelled`, { cause });
    if (timeout.signal.aborted) throw new Error(`${what} got no answer within ${REQUEST_TIMEOUT_MS / 1000} s`, { cause });
    throw new Error(`${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  } finally {
    clearTimeout(timer);
  }
  let body: Record<string, unknown> | undefined;
  try {
    body = asRecord(JSON.parse(text));
  } catch {
    body = undefined;
  }
  if (body === undefined) throw new Error(`${what} failed: HTTP ${response.status}, not JSON`);
  if (!response.ok) {
    const message = body['message'];
    throw new Error(`${what} failed: HTTP ${response.status}${typeof message === 'string' && message !== '' ? ` (${message.slice(0, 200)})` : ''}`);
  }
  return body;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isHttpUrl(value: string): boolean {
  return URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);
}
