import { BACKOFF_MAX_ATTEMPTS, BACKOFF_STEPS_SEC } from '@shared/constants';

export type RetryDecision =
  | { action: 'retry'; delayMs: number; reason: string }
  | { action: 'waitOffline'; reason: string }
  | { action: 'rateLimited'; delayMs: number; scope: 'minute' | 'hour' | 'day' | 'unknown' }
  | { action: 'blocked'; hint: string }
  | { action: 'giveUp'; reason: string };

/** Full jitter — a synchronised retry storm is how a shared IP gets itself blocked. */
export function backoffMs(attempt: number): number {
  const i = Math.min(Math.max(attempt - 1, 0), BACKOFF_STEPS_SEC.length - 1);
  const cap = BACKOFF_STEPS_SEC[i]! * 1000;
  return Math.floor(Math.random() * cap) + 1000;
}

function errName(e: unknown): string {
  const err = e as { name?: string; constructor?: { name?: string } } | null;
  return err?.constructor?.name || err?.name || '';
}

function errMessage(e: unknown): string {
  return String((e as Error | null)?.message ?? e ?? '');
}

/** Retry-After can arrive as seconds, ms, or a Date; all three are normalised here. */
function retryAfterMs(e: unknown): number | null {
  const anyE = e as { retryAfter?: unknown; retry_after?: unknown; data?: { retry_after?: unknown } } | null;
  const raw = anyE?.retryAfter ?? anyE?.retry_after ?? anyE?.data?.retry_after;
  if (raw == null) return null;
  if (raw instanceof Date) return Math.max(0, raw.getTime() - Date.now());
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 10_000 ? n * 1000 : n;
}

/**
 * The connect-failure policy. Every branch protects the Euler quota: an
 * anonymous client gets 100 sign requests/day, and a reconnect loop can burn
 * that in an evening.
 */
export function classify(e: unknown, attempt: number): RetryDecision {
  const name = errName(e);
  const msg = errMessage(e);

  if (name === 'SignatureRateLimitError' || /rate limit|too many connections|429/i.test(msg)) {
    const wait = retryAfterMs(e);
    const scope: 'minute' | 'hour' | 'day' | 'unknown' = /day/i.test(msg)
      ? 'day'
      : /hour/i.test(msg)
        ? 'hour'
        : /minute/i.test(msg)
          ? 'minute'
          : 'unknown';
    // Never retry sooner than the server said. Ever.
    return { action: 'rateLimited', delayMs: wait ?? 60_000, scope };
  }

  if (name === 'PremiumFeatureError' || /402|premium/i.test(msg)) {
    return { action: 'giveUp', reason: '有料プラン限定の機能が要求されました。' };
  }

  if (name === 'UserOfflineError' || /offline|not.*live|isn't live/i.test(msg)) {
    return { action: 'waitOffline', reason: '配信が始まっていません。' };
  }

  if (name === 'InvalidUniqueIdError' || /unique.?id|user.*not.*found/i.test(msg)) {
    return { action: 'giveUp', reason: 'ユーザー名が見つかりません。@なしの正しいユーザー名を入力してください。' };
  }

  if (name === 'AlreadyConnectedError' || name === 'AlreadyConnectingError') {
    return { action: 'retry', delayMs: 2000, reason: '既に接続処理中です。' };
  }

  if (name === 'SignatureMissingTokensError' || /sign|signature/i.test(msg)) {
    return { action: 'retry', delayMs: backoffMs(attempt), reason: '署名の取得に失敗しました。' };
  }

  if (attempt >= BACKOFF_MAX_ATTEMPTS) {
    return {
      action: 'blocked',
      hint: 'IP がブロックされている可能性があります。VPN を使用中なら切ってから再試行してください。',
    };
  }

  return { action: 'retry', delayMs: backoffMs(attempt), reason: msg || '接続に失敗しました。' };
}
