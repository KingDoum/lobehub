import { sendGotifyNotification } from '../notification/gotify';

export interface NotifyAgentRunCompletedParams {
  agentId?: string;
  duration?: number;
  lastAssistantContent?: string;
  operationId: string;
  topicId?: string;
  userId: string;
  workspaceId?: string;
}

/** Maximum length of the assistant preview carried in the notification body. */
const MAX_PREVIEW_LENGTH = 500;

/**
 * Minimum run duration worth a push, in milliseconds (`duration` comes from
 * `Date.now() - state.createdAt`). Everyday chat turns finish in seconds;
 * without this gate every reply would buzz the phone. Set to 0 to notify on
 * every completed run.
 */
const DEFAULT_MIN_DURATION_MS = 60_000;

/**
 * Same-topic pushes collapse to at most one per window, in milliseconds.
 * Absorbs multi-turn bursts on one conversation. Set to 0 to disable.
 */
const DEFAULT_TOPIC_WINDOW_MS = 120_000;

/** Map size that triggers a sweep of expired window entries. */
const TOPIC_MAP_SWEEP_THRESHOLD = 500;

/** topicId -> timestamp of the last push for that topic. */
const lastPushByTopic = new Map<string, number>();

/**
 * Kill switch: enabled by default, silenced with
 * `GOTIFY_NOTIFY_RUN_COMPLETED=0`.
 */
const isRunCompletedNotifyEnabled = (): boolean => process.env.GOTIFY_NOTIFY_RUN_COMPLETED !== '0';

/** Reads a non-negative numeric env var, falling back when unset or invalid. */
const readNonNegativeNumber = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/** Renders a run duration as a short human label, or nothing when unknown. */
const formatDuration = (duration: number | undefined): string | undefined => {
  if (duration === undefined) return undefined;

  const totalSeconds = Math.max(0, Math.round(duration / 1000));
  const minutes = Math.floor(totalSeconds / 60);

  return minutes === 0 ? `⏱ ${totalSeconds}s` : `⏱ ${minutes}m ${totalSeconds % 60}s`;
};

/** Builds a deep link back into the conversation when the deployment URL is known. */
const buildTopicUrl = (params: NotifyAgentRunCompletedParams): string | undefined => {
  const appUrl = process.env.APP_URL;

  if (!appUrl || !params.agentId) return undefined;

  const base = `${appUrl.replace(/\/+$/, '')}/agent/${params.agentId}`;

  return params.topicId ? `${base}?topic=${params.topicId}` : base;
};

/**
 * Records a push against the topic and reports whether an earlier push is
 * still inside the window. A window of `0` disables the check.
 */
const isThrottledByTopic = (topicId: string | undefined): boolean => {
  if (!topicId) return false;

  const windowMs = readNonNegativeNumber(
    process.env.GOTIFY_TOPIC_WINDOW_MS,
    DEFAULT_TOPIC_WINDOW_MS,
  );

  if (windowMs === 0) return false;

  const now = Date.now();
  const previous = lastPushByTopic.get(topicId);

  if (previous !== undefined && now - previous < windowMs) return true;

  lastPushByTopic.set(topicId, now);

  // Keep the map from growing without bound on a long-lived process.
  if (lastPushByTopic.size > TOPIC_MAP_SWEEP_THRESHOLD) {
    for (const [key, at] of lastPushByTopic) {
      if (now - at >= windowMs) lastPushByTopic.delete(key);
    }
  }

  return false;
};

/**
 * Notification outlet for a completed top-level agent run.
 *
 * Upstream OSS leaves this hook empty — the cloud build overrides the module
 * (`OSS deliberately performs no external side effect`). This is the
 * self-hosted implementation.
 *
 * The upstream caller already drops child runs and non-interactive triggers
 * (bots, evals, …), but `Chat` runs do reach here, so two further gates apply:
 *   1. duration — short conversational turns are not worth an interruption;
 *   2. per-topic window — a burst on one conversation yields a single push.
 */
export async function notifyAgentRunCompleted(
  params: NotifyAgentRunCompletedParams,
): Promise<void> {
  if (!isRunCompletedNotifyEnabled()) return;

  // Gate 1 — duration. An absent duration means the start time was not
  // readable; let it through rather than dropping a possibly-long run.
  if (params.duration !== undefined) {
    const minDurationMs = readNonNegativeNumber(
      process.env.GOTIFY_MIN_DURATION_MS,
      DEFAULT_MIN_DURATION_MS,
    );

    if (params.duration < minDurationMs) return;
  }

  // Gate 2 — per-topic window.
  if (isThrottledByTopic(params.topicId)) return;

  const preview = (params.lastAssistantContent ?? '').trim();
  const body =
    preview.length > MAX_PREVIEW_LENGTH ? `${preview.slice(0, MAX_PREVIEW_LENGTH)}…` : preview;

  const durationLabel = formatDuration(params.duration);
  const message = durationLabel ? `${durationLabel}\n\n${body || '(no text output)'}` : body;

  await sendGotifyNotification({
    dedupeKey: `agent-run-completed:${params.operationId}`,
    message: message || '(no text output)',
    priority: 1,
    title: '✅ Agent 任务已完成',
    url: buildTopicUrl(params),
  });
}
