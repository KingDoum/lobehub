/**
 * Gotify delivery channel for self-hosted deployments.
 *
 * Upstream OSS leaves every notification hook in this package as an empty
 * stub (`Cloud overrides this module; OSS deliberately performs no external
 * side effect`). This module provides the OSS-side delivery outlet those
 * stubs call into.
 *
 * Design constraints:
 * - Silently no-ops unless `GOTIFY_URL` and `GOTIFY_TOKEN` are both set, so an
 *   unconfigured deployment behaves exactly like upstream.
 * - Never rejects. Callers await this on the agent-run completion path, where a
 *   rejected promise would pollute the main flow.
 * - Quiet period: the same `dedupeKey` is delivered at most once per
 *   `GOTIFY_QUIET_MS` (default 30s), absorbing retries and duplicate hooks.
 */

/** Default quiet period per dedupe key, in milliseconds. */
const DEFAULT_QUIET_MS = 30_000;

/** Default per-request timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 8000;

/** Map size that triggers a sweep of expired dedupe entries. */
const DEDUPE_SWEEP_THRESHOLD = 500;

/** dedupeKey -> timestamp of the last delivery attempt. */
const lastDeliveredAt = new Map<string, number>();

export interface GotifyNotification {
  /** Dedupe key; defaults to `title`. Repeats within the quiet period are dropped. */
  dedupeKey?: string;
  /** Notification body. */
  message: string;
  /** Gotify priority (0-10). Defaults to 0. */
  priority?: number;
  /** Notification title. */
  title: string;
  /** Optional click-through URL, emitted as a Gotify client action. */
  url?: string;
}

/** Whether this deployment has a usable Gotify configuration. */
export const isGotifyConfigured = (): boolean =>
  Boolean(process.env.GOTIFY_URL && process.env.GOTIFY_TOKEN);

/** Renders a duration in milliseconds as a short human label, or nothing when unknown. */
export const formatDuration = (duration: number | undefined): string | undefined => {
  if (duration === undefined) return undefined;

  const totalSeconds = Math.max(0, Math.round(duration / 1000));
  const minutes = Math.floor(totalSeconds / 60);

  return minutes === 0 ? `⏱ ${totalSeconds}s` : `⏱ ${minutes}m ${totalSeconds % 60}s`;
};

/** Reads a non-negative numeric env var, falling back when unset or invalid. */
const readNonNegativeNumber = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const quietPeriodMs = (): number =>
  readNonNegativeNumber(process.env.GOTIFY_QUIET_MS, DEFAULT_QUIET_MS);

/**
 * Records the delivery attempt and reports whether the quiet period says to
 * skip it. A quiet period of `0` disables dedupe entirely.
 */
const shouldSkipByQuietPeriod = (dedupeKey: string): boolean => {
  const quietMs = quietPeriodMs();

  if (quietMs === 0) return false;

  const now = Date.now();
  const previous = lastDeliveredAt.get(dedupeKey);

  if (previous !== undefined && now - previous < quietMs) return true;

  lastDeliveredAt.set(dedupeKey, now);

  // Keep the map from growing without bound on a long-lived process.
  if (lastDeliveredAt.size > DEDUPE_SWEEP_THRESHOLD) {
    for (const [key, at] of lastDeliveredAt) {
      if (now - at >= quietMs) lastDeliveredAt.delete(key);
    }
  }

  return false;
};

/**
 * Delivers one notification to Gotify.
 *
 * Resolves regardless of outcome: unconfigured deployments return immediately,
 * and delivery failures are logged and swallowed.
 */
export const sendGotifyNotification = async (notification: GotifyNotification): Promise<void> => {
  const baseUrl = process.env.GOTIFY_URL;
  const token = process.env.GOTIFY_TOKEN;

  if (!baseUrl || !token) return;

  if (shouldSkipByQuietPeriod(notification.dedupeKey ?? notification.title)) return;

  try {
    const payload: Record<string, unknown> = {
      message: notification.message,
      priority: notification.priority ?? 0,
      title: notification.title,
    };

    if (notification.url) {
      payload.extras = {
        'client::display': { contentType: 'text/markdown' },
        'client::notification': { click: { url: notification.url } },
      };
    }

    const response = await fetch(
      `${baseUrl.replace(/\/+$/, '')}/message?token=${encodeURIComponent(token)}`,
      {
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(
          readNonNegativeNumber(process.env.GOTIFY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
        ),
      },
    );

    if (!response.ok) {
      console.warn(`[gotify] delivery failed with HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn('[gotify] delivery error:', error instanceof Error ? error.message : error);
  }
};
