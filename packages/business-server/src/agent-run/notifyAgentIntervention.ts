import type {
  AgentInterventionInteractionKind,
  AgentInterventionProvider,
  AgentInterventionRequestData,
} from '@lobechat/agent-gateway-client';

import { sendGotifyNotification } from '../notification/gotify';

export type AgentInterventionNotificationStatus =
  'cancelled' | 'pending' | 'resolved' | 'session_ended' | 'timed_out';

/**
 * Durable heterogeneous-intervention notification slot. Cloud overrides this
 * module; OSS deliberately performs no external side effect.
 */
export interface NotifyAgentInterventionParams {
  agentId?: string | null;
  deadline?: number;
  interactionKind: AgentInterventionInteractionKind;
  operationId: string;
  provider: AgentInterventionProvider | 'unknown';
  /**
   * Full producer request only on `pending`. Cloud must reconstruct a
   * canonical AskUserQuestion payload by whitelisting fields before storage,
   * and must never copy `arguments` directly into a push payload.
   */
  request?: AgentInterventionRequestData;
  /** Present on producer-ACK terminal transitions for claim correlation. */
  resolutionRequestId?: string;
  status: AgentInterventionNotificationStatus;
  /** Privacy-safe title; never contains raw tool arguments or answer values. */
  summary: string;
  toolCallId: string;
  topicId: string;
  userId: string;
  workspaceId?: string;
}

/**
 * Kill switch for the intervention push: enabled by default, silenced with
 * `GOTIFY_NOTIFY_AGENT_INTERVENTION=0`.
 */
const isAgentInterventionNotifyEnabled = (): boolean =>
  process.env.GOTIFY_NOTIFY_AGENT_INTERVENTION !== '0';

/** Builds a deep link back into the conversation when the deployment URL is known. */
const buildTopicUrl = (agentId: string | null | undefined, topicId: string): string | undefined => {
  const appUrl = process.env.APP_URL;

  if (!appUrl || !agentId) return undefined;

  return `${appUrl.replace(/\/+$/, '')}/agent/${agentId}?topic=${topicId}`;
};

/** Renders a millisecond deadline as a short human label. */
const formatDeadline = (deadline: number): string => {
  const remainingMs = Math.max(0, deadline - Date.now());

  if (remainingMs === 0) return '已到期';

  const minutes = Math.ceil(remainingMs / 60_000);

  if (minutes <= 60) return `${minutes} 分钟后过期`;

  return new Date(deadline).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
};

/**
 * Notification outlet for heterogeneous-intervention transitions.
 *
 * Upstream OSS leaves this hook empty — the cloud build overrides the module.
 * This self-hosted implementation pushes a high-priority alert when an Agent
 * is parked waiting for user input (`pending`); terminal transitions are left
 * to the in-app surface to avoid doubling up with the run-completed push.
 */
export async function notifyAgentIntervention(
  params: NotifyAgentInterventionParams,
): Promise<void> {
  if (!isAgentInterventionNotifyEnabled()) return;

  if (params.status !== 'pending') return;

  const details = [
    params.agentId ? `Agent: ${params.agentId}` : undefined,
    params.deadline ? `⏳ ${formatDeadline(params.deadline)}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');

  await sendGotifyNotification({
    dedupeKey: `agent-intervention:${params.toolCallId}`,
    message: details || params.summary,
    priority: 5,
    title: `⏸ Agent 等待审批：${params.summary}`,
    url: buildTopicUrl(params.agentId, params.topicId),
  });
}
