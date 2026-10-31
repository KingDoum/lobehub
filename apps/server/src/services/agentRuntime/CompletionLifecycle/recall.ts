/**
 * Completion push recall for runs the user is waiting on.
 */
import { RequestTrigger } from '@lobechat/types';
import debug from 'debug';

import { notifyAgentRunCompleted } from '@/business/server/agent-run/notifyAgentRunCompleted';
import { deliverInboxNotification } from '@/server/services/notification/deliverInbox';

import type { CompletionLifecycleDeps } from './types';

const log = debug('lobe-server:completion-lifecycle');

/**
 * Triggers whose completion recalls the user with a push notification. Beyond
 * plain chat: `Scheduled` is a user-deferred chat turn ("send this in 3
 * hours"), and `Cron` is today stamped only by the rate-limit auto-resume of a
 * user's own chat turn (see scheduledRunKinds) — both are exactly the "user
 * walked away mid-conversation" case the recall exists for. Everything else
 * (task runner, bots, evals, API, agent-signal self-iterations, …) is
 * background work and stays silent.
 */
const USER_RECALLABLE_TRIGGERS = new Set<string>([
  RequestTrigger.Chat,
  RequestTrigger.Cron,
  RequestTrigger.Scheduled,
]);

/**
 * The facts the recall gate needs. The trigger rides on `state.origin` for
 * in-process runs (the appContext spread); synthetic terminals
 * ({@link buildStateFromInput}) have none, so fall back to the op row
 * `recordStart` stamped — which also reveals `parentOperationId`, marking
 * internal child runs (verifier/repair/evidence pass it without `isSubAgent`).
 * `trigger: undefined` means neither source knows.
 */
export async function resolveRunRecallFacts(
  deps: CompletionLifecycleDeps,
  operationId: string,
  runOrigin: { trigger?: unknown } | undefined,
): Promise<{ isChildRun: boolean; trigger: string | undefined }> {
  if (typeof runOrigin?.trigger === 'string')
    return { isChildRun: false, trigger: runOrigin.trigger };

  try {
    const operation = await deps.agentOperationModel.findById(operationId);
    return {
      isChildRun: Boolean(operation?.parentOperationId),
      trigger: operation?.trigger ?? undefined,
    };
  } catch (error) {
    log('[%s] Failed to resolve run trigger from op row: %O', operationId, error);
    return { isChildRun: false, trigger: undefined };
  }
}

/** Maximum inbox body length; longer replies are truncated like the push preview. */
const MAX_INBOX_PREVIEW_LENGTH = 500;

/**
 * Builds the deep link stored on the inbox row, matching the shape the Gotify
 * channel already uses. Returns `undefined` when `APP_URL` is not configured,
 * in which case the inbox row simply has no click-through target.
 */
const buildInboxActionUrl = (
  agentId: string | undefined,
  topicId: string | undefined,
): string | undefined => {
  const appUrl = process.env.APP_URL;

  if (!appUrl || !agentId) return undefined;

  const base = `${appUrl.replace(/\/+$/, '')}/agent/${agentId}`;

  return topicId ? `${base}?topic=${topicId}` : base;
};

/**
 * Push a completion recall — but only for runs the user is waiting on.
 * Background executions (scheduled tasks, bots, evals, …) complete constantly
 * and would spam the OS banner. An unknown trigger passes: human-approval
 * chat continuations can reach here without one, and dropping a chat push is
 * worse than a rare stray banner.
 */
export async function recallUserOnCompletion(
  deps: CompletionLifecycleDeps,
  operationId: string,
  event: { agentId?: string; duration?: number; lastAssistantContent?: string; topicId?: string },
  runOrigin: { trigger?: unknown; userId?: string } | undefined,
): Promise<void> {
  const { isChildRun, trigger } = await resolveRunRecallFacts(deps, operationId, runOrigin);
  if (isChildRun) {
    log('[%s] Skipping completion push for internal child run', operationId);
    return;
  }
  if (trigger !== undefined && !USER_RECALLABLE_TRIGGERS.has(trigger)) {
    log('[%s] Skipping completion push for non-interactive trigger %s', operationId, trigger);
    return;
  }

  await notifyAgentRunCompleted({
    agentId: event.agentId || undefined,
    duration: event.duration,
    lastAssistantContent: event.lastAssistantContent,
    operationId,
    topicId: event.topicId,
    userId: runOrigin?.userId || deps.userId,
    // Personal runs leave this undefined ⇒ bare deep link; workspace
    // runs carry the id so the business slot can slug-prefix the URL.
    workspaceId: deps.workspaceId,
  });

  // Self-host: mirror the same recall into the in-app inbox and the Expo push
  // channel. The cloud build does this inside its closed NotificationService;
  // OSS has no such service, so it is wired here — at the one call site that
  // has already applied the child-run and trigger gates above.
  const preview = (event.lastAssistantContent ?? '').trim();
  const minDurationMs = Number(process.env.GOTIFY_MIN_DURATION_MS || 600_000);

  await deliverInboxNotification({
    actionUrl: buildInboxActionUrl(event.agentId, event.topicId),
    category: 'agent',
    content:
      preview.length > MAX_INBOX_PREVIEW_LENGTH
        ? `${preview.slice(0, MAX_INBOX_PREVIEW_LENGTH)}…`
        : preview || '(no text output)',
    dedupeKey: `agent-run-completed:${operationId}`,
    push: event.duration === undefined || event.duration >= minDurationMs,
    title: '✅ Agent 任务已完成',
    type: 'agent_run_completed',
    userId: runOrigin?.userId || deps.userId,
    workspaceId: deps.workspaceId,
  });
}
