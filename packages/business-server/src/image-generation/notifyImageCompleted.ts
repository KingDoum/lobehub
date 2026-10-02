import { formatDuration, sendGotifyNotification } from '../notification/gotify';

interface NotifyImageCompletedParams {
  duration: number;
  generationBatchId: string;
  model: string;
  prompt: string;
  topicId?: string;
  userId: string;
  /** Present when the generation ran in a workspace — the notification then follows that context. */
  workspaceId?: string;
}

/** Kill switch: enabled by default, silenced with `GOTIFY_NOTIFY_MEDIA=0`. */
const isMediaNotifyEnabled = (): boolean => process.env.GOTIFY_NOTIFY_MEDIA !== '0';

/**
 * Notification outlet for an async image generation completing.
 * Upstream OSS leaves this hook empty; this is the self-hosted implementation.
 */
export async function notifyImageCompleted(params: NotifyImageCompletedParams): Promise<void> {
  if (!isMediaNotifyEnabled()) return;

  const promptPreview = (params.prompt ?? '').trim().slice(0, 120);

  const message = [
    promptPreview || '(no prompt)',
    formatDuration(params.duration),
    params.model ? `模型：${params.model}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');

  await sendGotifyNotification({
    dedupeKey: `image-completed:${params.generationBatchId}`,
    message,
    priority: 1,
    title: '🖼 图片生成完成',
  });
}
