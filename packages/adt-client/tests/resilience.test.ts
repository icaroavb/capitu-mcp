import { describe, expect, it, vi } from 'vitest';
import {
  describeAdtError,
  detectRetryReason,
  inspectAdtError,
  isAlreadyExistsError,
  isLockedByOtherUserError,
  isPossiblyDirtySession,
  summarizeAdtError,
  withRetry,
} from '../src/resilience.js';

/**
 * Build a minimal object that quacks like an `AdtErrorException` from
 * abap-adt-api: own `message`, `localizedMessage`, `type`, `properties` and
 * the response status the lib forwards. Keeps these tests independent of the
 * real lib (and decoupled from any version bump).
 */
function fakeAdtErr(opts: {
  message: string;
  localizedMessage?: string;
  type?: string;
  subType?: string;
  t100Id?: string;
  t100No?: string;
  status?: number;
}): Error {
  const e = new Error(opts.message) as Error & Record<string, unknown>;
  if (opts.localizedMessage) e.localizedMessage = opts.localizedMessage;
  if (opts.type) e.type = opts.type;
  const props: Record<string, string> = {};
  if (opts.subType) props['com.sap.adt.communicationFramework.subType'] = opts.subType;
  if (opts.t100Id) props['T100KEY-ID'] = opts.t100Id;
  if (opts.t100No) props['T100KEY-NO'] = opts.t100No;
  e.properties = props;
  if (opts.status) e.err = opts.status;
  return e;
}

describe('detectRetryReason', () => {
  it('detects 401 / session expiration variants', () => {
    expect(detectRetryReason(new Error('HTTP 401 Unauthorized'))).toBe('session-401');
    expect(detectRetryReason(new Error('CSRF token validation failed'))).toBe('session-401');
    expect(detectRetryReason(new Error('Session expired'))).toBe('session-401');
  });

  it('detects ED064 activation coupling', () => {
    expect(detectRetryReason(new Error('Local classes of CL_ABAP_BEHAVIOR_HANDLER missing'))).toBe(
      'ed064-activation',
    );
    expect(detectRetryReason(new Error('ED064: activation failed'))).toBe('ed064-activation');
  });

  it('detects transient network errors', () => {
    expect(detectRetryReason(new Error('ECONNRESET'))).toBe('transient-network');
    expect(detectRetryReason(new Error('socket hang up'))).toBe('transient-network');
    expect(detectRetryReason(new Error('ETIMEDOUT after 30s'))).toBe('transient-network');
  });

  it('returns null for unrelated errors', () => {
    expect(detectRetryReason(new Error('Object not found'))).toBeNull();
    expect(detectRetryReason(new Error('Permission denied'))).toBeNull();
    expect(detectRetryReason(null)).toBeNull();
  });
});

describe('withRetry', () => {
  it('returns first attempt result when no error', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries once on session-401 and succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('HTTP 401 Unauthorized');
      return 'recovered';
    });
    const result = await withRetry(fn, { delayMs: 1 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on non-recoverable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Object not found'));
    await expect(withRetry(fn, { delayMs: 1 })).rejects.toThrow('Object not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects maxRetries limit', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('HTTP 401'));
    await expect(withRetry(fn, { maxRetries: 2, delayMs: 1 })).rejects.toThrow('HTTP 401');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('calls onRetry before each retry with context', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('ED064: activation failed');
      return 'recovered';
    });
    const onRetry = vi.fn();
    await withRetry(fn, { delayMs: 1, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 2,
        reason: 'ed064-activation',
        errorMessage: expect.stringContaining('ED064'),
      }),
    );
  });

  it('passes the attempt number to fn', async () => {
    const attempts: number[] = [];
    let calls = 0;
    await withRetry(
      async (attempt) => {
        attempts.push(attempt);
        calls++;
        if (calls < 2) throw new Error('HTTP 401');
        return 'ok';
      },
      { delayMs: 1 },
    );
    expect(attempts).toEqual([1, 2]);
  });

  it('allows custom detect predicate', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('custom-retryable');
      return 'ok';
    });
    const result = await withRetry(fn, {
      delayMs: 1,
      detect: (err) =>
        err instanceof Error && err.message.includes('custom-retryable')
          ? 'transient-network'
          : null,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('inspectAdtError', () => {
  it('prefers localizedMessage over message', () => {
    const err = fakeAdtErr({
      message: 'Request failed with status code 400',
      localizedMessage: 'Resource CLAS ZCL_X does already exist (ExceptionResourceAlreadyExists)',
      type: 'ExceptionResourceAlreadyExists',
      status: 400,
    });
    const d = inspectAdtError(err);
    expect(d.status).toBe(400);
    expect(d.exceptionType).toBe('ExceptionResourceAlreadyExists');
    expect(d.message).toContain('ExceptionResourceAlreadyExists');
    expect(d.message).not.toContain('status code 400');
  });

  it('falls back to message when localizedMessage is missing', () => {
    const d = inspectAdtError(new Error('Plain failure'));
    expect(d.message).toBe('Plain failure');
    expect(d.exceptionType).toBeUndefined();
  });

  it('extracts T100KEY from properties', () => {
    const err = fakeAdtErr({
      message: 'fail',
      t100Id: 'ZABAP',
      t100No: '042',
    });
    expect(inspectAdtError(err).t100Key).toBe('ZABAP-042');
  });

  it('handles primitive errors', () => {
    expect(inspectAdtError('plain string').message).toBe('plain string');
    expect(inspectAdtError(null).message).toMatch(/null/);
  });
});

describe('describeAdtError', () => {
  it('joins status + type + message in one line', () => {
    const err = fakeAdtErr({
      message: 'Request failed with status code 400',
      localizedMessage: 'Resource already exists',
      type: 'ExceptionResourceAlreadyExists',
      status: 400,
    });
    const text = describeAdtError(err);
    expect(text).toContain('HTTP 400');
    expect(text).toContain('ExceptionResourceAlreadyExists');
    expect(text).toContain('Resource already exists');
  });

  it('handles plain Errors gracefully', () => {
    expect(describeAdtError(new Error('boom'))).toContain('boom');
  });
});

describe('isAlreadyExistsError', () => {
  it('matches via ADT exception type', () => {
    expect(
      isAlreadyExistsError(fakeAdtErr({ message: 'm', type: 'ExceptionResourceAlreadyExists' })),
    ).toBe(true);
  });

  it('matches via subType string', () => {
    expect(
      isAlreadyExistsError(fakeAdtErr({ message: 'm', subType: 'ExceptionResourceAlreadyExists' })),
    ).toBe(true);
  });

  it('matches via localized message text', () => {
    expect(
      isAlreadyExistsError(
        fakeAdtErr({ message: 'm', localizedMessage: 'Object Z does already exist' }),
      ),
    ).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isAlreadyExistsError(new Error('Locked by other user'))).toBe(false);
    expect(isAlreadyExistsError(null)).toBe(false);
  });
});

describe('isLockedByOtherUserError', () => {
  it('matches ExceptionResourceLockedByAnotherUser', () => {
    expect(
      isLockedByOtherUserError(
        fakeAdtErr({
          message: 'fail',
          type: 'ExceptionResourceLockedByAnotherUser',
        }),
      ),
    ).toBe(true);
  });
});

describe('isPossiblyDirtySession', () => {
  it('flags HTTP 400 with no ABAP exception type', () => {
    expect(isPossiblyDirtySession(fakeAdtErr({ message: 'x', status: 400 }))).toBe(true);
  });

  it('does NOT flag 400 with a real ABAP exception', () => {
    expect(
      isPossiblyDirtySession(
        fakeAdtErr({
          message: 'x',
          status: 400,
          type: 'ExceptionResourceAlreadyExists',
        }),
      ),
    ).toBe(false);
  });

  it('does NOT flag unrelated status codes', () => {
    expect(isPossiblyDirtySession(fakeAdtErr({ message: 'x', status: 404 }))).toBe(false);
    expect(isPossiblyDirtySession(new Error('boom'))).toBe(false);
  });
});

describe('summarizeAdtError', () => {
  it('strips HTML tags', () => {
    expect(summarizeAdtError(new Error('<html><body>Error: <b>X</b> failed</body></html>'))).toBe(
      'Error: X failed',
    );
  });

  it('caps long messages', () => {
    const long = 'A'.repeat(500);
    const out = summarizeAdtError(new Error(long));
    expect(out.length).toBeLessThanOrEqual(401); // 400 + ellipsis
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles non-Error values', () => {
    expect(summarizeAdtError('string error')).toBe('string error');
    expect(summarizeAdtError(null)).toContain('null');
  });
});
