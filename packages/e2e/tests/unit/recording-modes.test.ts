/** Which attempts record and keep a trace or a video under each mode, and how firmly the engine is asked. */

import { describe, expect, it } from 'vitest';
import { attemptRecording, recordsOnSomeAttempt } from '../../src/internal/recording-modes.ts';

const set = { source: 'run' } as const;

describe('attemptRecording', () => {
  it('records every attempt for on and retain-on-failure, keeping all or only failures', () => {
    expect([0, 1, 2].map((index) => attemptRecording({ mode: 'on', ...set }, index))).toEqual([
      { keep: 'always', policy: 'required' },
      { keep: 'always', policy: 'required' },
      { keep: 'always', policy: 'required' },
    ]);
    expect(attemptRecording({ mode: 'retain-on-failure', ...set }, 0)).toEqual({ keep: 'on-failure', policy: 'required' });
    expect(attemptRecording({ mode: 'retain-on-failure', ...set }, 3)).toEqual({ keep: 'on-failure', policy: 'required' });
  });

  it('records nothing for off, only the first retry for on-first-retry, and every retry for on-all-retries', () => {
    expect(attemptRecording({ mode: 'off', ...set }, 0)).toBeUndefined();
    expect([0, 1, 2].map((index) => attemptRecording({ mode: 'on-first-retry', ...set }, index)?.keep)).toEqual([undefined, 'always', undefined]);
    expect([0, 1, 2].map((index) => attemptRecording({ mode: 'on-all-retries', ...set }, index)?.keep)).toEqual([undefined, 'always', 'always']);
  });

  it('asks best-effort for a default mode and requires one somebody set', () => {
    expect(attemptRecording({ mode: 'on', source: 'default' }, 0)?.policy).toBe('best-effort');
    for (const source of ['run', 'target', 'test'] as const) {
      expect(attemptRecording({ mode: 'on', source }, 0)?.policy).toBe('required');
    }
  });
});

describe('recordsOnSomeAttempt', () => {
  it('asks the engine only when some attempt records', () => {
    expect(recordsOnSomeAttempt('off', 3)).toBe(false);
    expect(recordsOnSomeAttempt('on', 0)).toBe(true);
    expect(recordsOnSomeAttempt('retain-on-failure', 0)).toBe(true);
    expect(recordsOnSomeAttempt('on-first-retry', 0)).toBe(false);
    expect(recordsOnSomeAttempt('on-first-retry', 1)).toBe(true);
    expect(recordsOnSomeAttempt('on-all-retries', 0)).toBe(false);
    expect(recordsOnSomeAttempt('on-all-retries', 2)).toBe(true);
  });
});
