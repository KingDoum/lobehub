import type { NotificationMetadata } from '@lobechat/types';
import debug from 'debug';

import { NotificationModel } from '@/database/models/notification';
import { serverDB } from '@/database/server';
import { PushChannel } from '@/server/services/push/PushChannel';

const log = debug('lobe-notification:inbox');

/**
 * Self-hosted inbox delivery.
 *
 * Upstream OSS leaves every `notifyXxx` hook empty because the write side of
 * the notification pipeline lives in the closed cloud build. That missing
 * piece is what normally does two things:
 *
 *   1. persists a row in `notifications` (the in-app inbox / bell)
 *   2. records a row in `notification_deliveries` for every channel it fanned
 *      the notification out to
 *
 * This module is the self-hosted replacement for (1) plus the push channel of
 * (2). It deliberately does NOT re-implement the gating policy (duration floor,
 * per-topic window): those stay in the caller so the inbox, Gotify and push
 * channels cannot drift apart.
 *
 * Design constraints, mirroring `business-server/src/notification/gotify.ts`:
 * - Never rejects. Callers await this on the agent-run completion path, where a
 *   rejected promise would pollute the main flow.
 * - Degrades per stage: a failed push never loses the inbox row.
 * - Kill switch: `INBOX_NOTIFY_ENABLED=0` turns the whole module into a no-op.
 */
export interface InboxNotificationInput {
  /** Deep link opened when the notification is tapped. */
  actionUrl?: string;
  /** High-level grouping used by inbox tabs and preference toggles. */
  category: string;
  /** Notification body text. */
  content: string;
  /** Optional secondary context rendered by inbox surfaces. */
  context?: string;
  /**
   * Idempotency key. The `(user_id, dedupe_key)` unique index collapses
   * repeats into the first row, so a retry cannot create a second inbox entry.
   */
  dedupeKey?: string;
  /** Structured extras for inbox rendering. */
  metadata?: NotificationMetadata;
  /** Whether to also fan out to the Expo push channel. */
  push?: boolean;
  title: string;
  /** Scenario identifier, e.g. `agent_run_completed`. */
  type: string;
  userId: string;
  workspaceId?: string | null;
}

/** Kill switch: enabled by default, silenced with `INBOX_NOTIFY_ENABLED=0`. */
const isInboxNotifyEnabled = (): boolean => process.env.INBOX_NOTIFY_ENABLED !== '0';

/**
 * Persists an inbox notification and optionally pushes it to the user's
 * registered devices.
 *
 * Returns once both stages have settled. Never throws — every failure is logged
 * and swallowed so the caller's main flow is unaffected.
 */
export const deliverInboxNotification = async (input: InboxNotificationInput): Promise<void> => {
  if (!isInboxNotifyEnabled()) return;

  const model = new NotificationModel(serverDB, input.userId, {
    workspaceId: input.workspaceId ?? null,
  });

  // ── Stage 1: the inbox row ──────────────────────────────────────────────
  // Without an id there is nothing for a delivery record to reference, so a
  // failure here ends the call.
  let notificationId: string | undefined;

  try {
    const row = await model.create({
      actionUrl: input.actionUrl,
      category: input.category,
      content: input.content,
      context: input.context,
      dedupeKey: input.dedupeKey,
      metadata: input.metadata,
      title: input.title,
      type: input.type,
      workspaceId: input.workspaceId ?? null,
    });

    notificationId = row?.id;

    if (!row) {
      // `onConflictDoNothing` hit the (userId, dedupeKey) unique index: this
      // exact notification already exists. Pushing again would double-buzz.
      log('Inbox row deduped (userId=%s key=%s)', input.userId, input.dedupeKey);
      return;
    }
  } catch (error) {
    log('Failed to persist inbox row: %O', error);
    return;
  }

  if (!input.push) return;

  // ── Stage 2: push fan-out ───────────────────────────────────────────────
  // A failure here must not surface: the inbox row is already durable, and the
  // user still sees it the next time the app is opened.
  try {
    const result = await new PushChannel().deliver({
      actionUrl: input.actionUrl,
      content: input.content,
      notificationId,
      title: input.title,
      type: input.type,
      userId: input.userId,
    });

    await model.createDelivery({
      channel: 'push',
      failedReason: result.status === 'failed' ? result.failedReason : undefined,
      notificationId,
      providerMessageId: result.providerMessageId,
      sentAt: result.status === 'failed' ? undefined : new Date(),
      status: result.status,
    });

    log(
      'Push notificationId=%s status=%s reason=%s',
      notificationId,
      result.status,
      result.failedReason ?? '-',
    );
  } catch (error) {
    log('Push delivery threw: %O', error);
  }
};
