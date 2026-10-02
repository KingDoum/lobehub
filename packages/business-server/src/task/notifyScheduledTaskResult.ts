import { sendGotifyNotification } from '../notification/gotify';

export interface NotifyScheduledTaskCompletedParams {
  /** Agent executing the task — lets inbox surfaces render its avatar. */
  agentId?: string;
  /** Final assistant reply text of the tick — may be used to build a preview. */
  lastAssistantContent?: string;
  operationId: string;
  taskId: string;
  /** Workspace-level task identifier (e.g. 'T-1'), used as the name fallback. */
  taskIdentifier: string;
  taskName?: string;
  topicId?: string;
  userId: string;
  workspaceId?: string;
}

export interface NotifyScheduledTaskFailedParams {
  /** Agent executing the task — lets inbox surfaces render its avatar. */
  agentId?: string;
  /** Consecutive automation-tick failures including this one (schedule fuse). */
  consecutiveFailures?: number;
  /** Structured terminal error type (e.g. `InsufficientBudgetForModel`). Never
   *  the raw error text — that stays in briefs/logs. */
  errorCode?: string;
  operationId: string;
  /** True when this failure blew the fuse and auto-paused the task. */
  paused?: boolean;
  runTrigger: 'heartbeat' | 'schedule';
  taskId: string;
  taskIdentifier: string;
  taskName?: string;
  topicId?: string;
  userId: string;
  workspaceId?: string;
}

/** Maximum length of the completion preview carried in the notification body. */
const MAX_PREVIEW_LENGTH = 300;

/** Same-task completion pushes collapse to at most one per window (ms). 0 disables. */
const DEFAULT_TASK_WINDOW_MS = 600_000;

/** Map size that triggers a sweep of expired window entries. */
const TASK_MAP_SWEEP_THRESHOLD = 200;

/** taskId -> timestamp of the last completion push. */
const lastCompletedAtByTask = new Map<string, number>();

/** Kill switch: enabled by default, silenced with `GOTIFY_NOTIFY_SCHEDULED_TASK=0`. */
const isScheduledTaskNotifyEnabled = (): boolean =>
  process.env.GOTIFY_NOTIFY_SCHEDULED_TASK !== '0';

/** Reads a non-negative numeric env var, falling back when unset or invalid. */
const readNonNegativeNumber = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * Records a completion push against the task and reports whether an earlier
 * push is still inside the window — heartbeat ticks would otherwise spam.
 */
const isThrottledByTask = (taskId: string): boolean => {
  const windowMs = readNonNegativeNumber(
    process.env.GOTIFY_SCHEDULED_TASK_WINDOW_MS,
    DEFAULT_TASK_WINDOW_MS,
  );

  if (windowMs === 0) return false;

  const now = Date.now();
  const previous = lastCompletedAtByTask.get(taskId);

  if (previous !== undefined && now - previous < windowMs) return true;

  lastCompletedAtByTask.set(taskId, now);

  if (lastCompletedAtByTask.size > TASK_MAP_SWEEP_THRESHOLD) {
    for (const [key, at] of lastCompletedAtByTask) {
      if (now - at >= windowMs) lastCompletedAtByTask.delete(key);
    }
  }

  return false;
};

/** Builds a deep link back into the task topic when the deployment URL is known. */
const buildTaskUrl = (
  agentId: string | undefined,
  topicId: string | undefined,
): string | undefined => {
  const appUrl = process.env.APP_URL;

  if (!appUrl || !agentId || !topicId) return undefined;

  return `${appUrl.replace(/\/+$/, '')}/agent/${agentId}?topic=${topicId}`;
};

/**
 * Notification outlet for a completed scheduled-task tick.
 * Upstream OSS leaves both hooks empty; this is the self-hosted implementation.
 */
export async function notifyScheduledTaskCompleted(
  params: NotifyScheduledTaskCompletedParams,
): Promise<void> {
  if (!isScheduledTaskNotifyEnabled()) return;

  if (isThrottledByTask(params.taskId)) return;

  const name = params.taskName ?? params.taskIdentifier;
  const preview = (params.lastAssistantContent ?? '').trim();
  const body =
    preview.length > MAX_PREVIEW_LENGTH ? `${preview.slice(0, MAX_PREVIEW_LENGTH)}…` : preview;

  await sendGotifyNotification({
    dedupeKey: `scheduled-task-completed:${params.operationId}`,
    message: body || '(no text output)',
    priority: 1,
    title: `📅 定时任务完成：${name}`,
    url: buildTaskUrl(params.agentId, params.topicId),
  });
}

/**
 * Notification outlet for a failed scheduled-task tick. Failures always push —
 * they must not be absorbed by the completion window.
 */
export async function notifyScheduledTaskFailed(
  params: NotifyScheduledTaskFailedParams,
): Promise<void> {
  if (!isScheduledTaskNotifyEnabled()) return;

  const name = params.taskName ?? params.taskIdentifier;
  const pausedSuffix = params.paused ? '（已自动暂停）' : '';

  const details = [
    params.errorCode ? `错误：${params.errorCode}` : undefined,
    params.consecutiveFailures && params.consecutiveFailures > 1
      ? `连续失败 ${params.consecutiveFailures} 次`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join(' · ');

  await sendGotifyNotification({
    dedupeKey: `scheduled-task-failed:${params.operationId}`,
    message: details || '（无错误详情）',
    priority: 5,
    title: `❌ 定时任务失败：${name}${pausedSuffix}`,
    url: buildTaskUrl(params.agentId, params.topicId),
  });
}
