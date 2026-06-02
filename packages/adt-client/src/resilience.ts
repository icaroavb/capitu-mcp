/**
 * Resilience helpers: typed error detection + bounded retry.
 *
 * Two real-world failure modes we now handle:
 *
 *  1. Stale session (HTTP 401 after a long idle gap). SAP CSRF cookies expire
 *     on the server side; our adt-api instance still thinks it's logged in.
 *     Solution: detect 401, re-login once, retry.
 *
 *  2. ED064 activation coupling. RAP behavior implementation classes
 *     occasionally fail to activate with `ED064` ("Local classes of
 *     CL_ABAP_BEHAVIOR_HANDLER…") because the just-written CCDEF/CCIMP isn't
 *     visible to the same-request activation. A second attempt (after a small
 *     pause) usually succeeds. ARC-1 surfaced this in PR #255.
 *
 * The retry policy is deliberately narrow: only retry on KNOWN-recoverable
 * errors, never blindly. Each retry is logged in @capitu/kb traces so we can
 * audit how often it kicks in.
 */

export type RetryReason =
  | 'session-401'
  | 'ed064-activation'
  | 'transient-network'
  | 'stateful-dirty';

export interface RetryContext {
  attempt: number;
  reason: RetryReason;
  errorMessage: string;
}

export function detectRetryReason(err: unknown): RetryReason | null {
  const msg = errorMessage(err);
  if (!msg) return null;
  const upper = msg.toUpperCase();

  // 1. Session expired
  if (
    upper.includes('401') ||
    upper.includes('UNAUTHORIZED') ||
    upper.includes('SESSION EXPIRED') ||
    upper.includes('CSRF TOKEN')
  ) {
    return 'session-401';
  }

  // 2. ED064 activation coupling (RAP)
  if (upper.includes('ED064') || upper.includes('CL_ABAP_BEHAVIOR_HANDLER')) {
    return 'ed064-activation';
  }

  // 3. Transient network blips
  if (
    upper.includes('ECONNRESET') ||
    upper.includes('ETIMEDOUT') ||
    upper.includes('SOCKET HANG UP')
  ) {
    return 'transient-network';
  }

  return null;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Structured detail extracted from an abap-adt-api error.
 *
 * abap-adt-api throws `AdtErrorException` instances whose `.message` is just
 * the HTTP status line ("Request failed with status code 400") — the actual
 * SAP message lives in `.localizedMessage`, `.properties` (T100KEY) and the
 * exception type / subType. This helper digs those out without depending on
 * the lib's type at runtime (it duck-types on the field names).
 */
export interface AdtErrorDetail {
  /** HTTP status code if present. */
  status?: number;
  /** Best human-readable text — prefers localizedMessage, falls back to message. */
  message: string;
  /** ADT exception type, e.g. "ExceptionResourceAlreadyExists" — used for idempotency checks. */
  exceptionType?: string;
  /** The "subType" property — sometimes the only place ExceptionResource* shows up. */
  subType?: string;
  /** T100 message ID + number (`ID-NO`) when ADT bothered to include it. */
  t100Key?: string;
  /** Raw response body, if the lib forwarded one. */
  responseBody?: string;
}

interface AdtErrorLike {
  message?: string;
  localizedMessage?: string;
  type?: string;
  namespace?: string;
  properties?: Record<string, string>;
  err?: number;
  response?: { status?: number; body?: string };
  parent?: { message?: string; response?: { status?: number; data?: unknown } };
}

export function inspectAdtError(err: unknown): AdtErrorDetail {
  if (!err || typeof err !== 'object') {
    return { message: errorMessage(err) };
  }
  const e = err as AdtErrorLike;
  const status = e.err ?? e.response?.status ?? e.parent?.response?.status ?? undefined;
  const exceptionType = e.type;
  const subType =
    e.properties?.['com.sap.adt.communicationFramework.subType'] ?? e.properties?.subType;
  const t100Id = e.properties?.['T100KEY-ID'];
  const t100No = e.properties?.['T100KEY-NO'];
  const t100Key = t100Id && t100No ? `${t100Id}-${t100No}` : undefined;
  // Prefer localizedMessage > message > fallback. abap-adt-api leaves
  // localizedMessage with the SAP-side text we want.
  const message =
    e.localizedMessage?.trim() ||
    (typeof e.message === 'string' && e.message.trim()) ||
    e.parent?.message?.trim() ||
    'Unknown ADT error';
  let responseBody: string | undefined;
  if (typeof e.response?.body === 'string') {
    responseBody = e.response.body;
  } else if (typeof e.parent?.response?.data === 'string') {
    responseBody = e.parent.response.data;
  }
  return { status, message, exceptionType, subType, t100Key, responseBody };
}

/**
 * One-line human summary of an ADT error, suitable for surfacing inside MCP
 * tool responses. Combines status, ABAP exception type, and the localized
 * message so callers actually see why SAP rejected the call.
 */
export function describeAdtError(err: unknown): string {
  const d = inspectAdtError(err);
  const parts: string[] = [];
  if (d.status) parts.push(`HTTP ${d.status}`);
  if (d.exceptionType) parts.push(d.exceptionType);
  else if (d.subType) parts.push(d.subType);
  if (d.t100Key) parts.push(`[${d.t100Key}]`);
  parts.push(d.message);
  return parts.join(' — ');
}

/**
 * Type-of-error helpers — pure string match on the structured fields so
 * callers don't have to know about subType naming conventions.
 */
export function isAlreadyExistsError(err: unknown): boolean {
  const d = inspectAdtError(err);
  const haystack = `${d.exceptionType ?? ''} ${d.subType ?? ''} ${d.message}`.toUpperCase();
  // SAP messages: "does already exist" (singular) and "already exists" (plural)
  // both appear in the wild depending on the object type and SAP_BASIS release.
  return (
    haystack.includes('RESOURCEALREADYEXISTS') || haystack.includes('ALREADY EXIST') // covers "exist" and "exists"
  );
}

export function isLockedByOtherUserError(err: unknown): boolean {
  const d = inspectAdtError(err);
  const haystack = `${d.exceptionType ?? ''} ${d.subType ?? ''} ${d.message}`.toUpperCase();
  return haystack.includes('LOCKEDBYANOTHERUSER') || haystack.includes('LOCKED BY');
}

/**
 * Detects "the stateful HTTP session is dirty" — once SAP rejects a POST on
 * a stateful session, the *next* unrelated call (even a clean GET) starts
 * coming back as 400 too until the session is recycled. The classic markers
 * are HTTP 400 with no useful body, or a 500 immediately after another 4xx.
 *
 * We can only tell after the fact, so callers track whether the previous
 * call failed and pass that context in.
 */
export function isPossiblyDirtySession(err: unknown): boolean {
  const d = inspectAdtError(err);
  if (!d.status) return false;
  if (d.status !== 400 && d.status !== 500) return false;
  // A 400 with a real ABAP exception type is a real business error, not session corruption.
  if (d.exceptionType && !d.exceptionType.startsWith('Exception')) return true;
  if (!d.exceptionType && !d.subType) return true;
  return false;
}

export interface WithRetryOptions {
  /** Max retry attempts (excluding initial). Default: 1 — total 2 tries. */
  maxRetries?: number;
  /** Delay between retries in ms. Default: 500. */
  delayMs?: number;
  /** Called once before each retry (after a recoverable failure). */
  onRetry?: (ctx: RetryContext) => Promise<void> | void;
  /** Override what counts as recoverable. Default: detectRetryReason. */
  detect?: (err: unknown) => RetryReason | null;
}

/**
 * Run `fn` with bounded retry on known-recoverable errors.
 *
 * `fn` receives the attempt number (starts at 1). Use it if your retry
 * needs to take a different code path on the second try (e.g. re-login
 * before issuing the next request).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 1;
  const delayMs = opts.delayMs ?? 500;
  const detect = opts.detect ?? detectRetryReason;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt > maxRetries) break;
      const reason = detect(err);
      if (!reason) break;
      const ctx: RetryContext = {
        attempt: attempt + 1,
        reason,
        errorMessage: errorMessage(err),
      };
      if (opts.onRetry) {
        await opts.onRetry(ctx);
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

/**
 * Strip ABAP/HTTP transport noise from an error message before showing it
 * to the user — keeps the actual SAP message, drops headers and stack frames.
 */
export function summarizeAdtError(err: unknown): string {
  const msg = errorMessage(err);
  if (!msg) return 'Unknown error';
  // SAP messages frequently come wrapped in HTML — best-effort strip
  const noHtml = msg
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Cap length so logs stay readable
  return noHtml.length > 400 ? `${noHtml.slice(0, 400)}…` : noHtml;
}
