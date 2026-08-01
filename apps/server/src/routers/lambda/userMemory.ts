import {
  AsyncTaskError,
  AsyncTaskErrorType,
  AsyncTaskStatus,
  AsyncTaskType,
  CreateUserMemoryIdentitySchema,
  MemorySourceType,
  UpdateUserMemoryIdentitySchema,
  type UserMemoryExtractionMetadata,
} from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { withScopedPermission } from '@/business/server/trpc-middlewares/rbacPermission';
import { wsCompatProcedure } from '@/business/server/trpc-middlewares/workspaceAuth';
import { AsyncTaskModel, initUserMemoryExtractionMetadata } from '@/database/models/asyncTask';
import { TopicModel } from '@/database/models/topic';
import {
  UserMemoryActivityModel,
  UserMemoryContextModel,
  UserMemoryExperienceModel,
  UserMemoryIdentityModel,
  UserMemoryModel,
  UserMemoryPreferenceModel,
} from '@/database/models/userMemory';
import {
  UserPersonaModel,
  UserPersonaVersionNotFoundError,
  UserPersonaVersionSnapshotMissingError,
} from '@/database/models/userMemory/persona';
import { appEnv } from '@/envs/app';
import { router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { parseMemoryExtractionConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';
import {
  buildWorkflowPayloadInput,
  MemoryExtractionExecutor,
  MemoryExtractionWorkflowService,
  normalizeMemoryExtractionPayload,
} from '@/server/services/memory/userMemory/extract';

const userMemoryProcedure = wsCompatProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;
  const wsId = ctx.workspaceId ?? undefined;

  return opts.next({
    ctx: {
      activityModel: new UserMemoryActivityModel(ctx.serverDB, ctx.userId),
      asyncTaskModel: new AsyncTaskModel(ctx.serverDB, ctx.userId, wsId),
      contextModel: new UserMemoryContextModel(ctx.serverDB, ctx.userId),
      experienceModel: new UserMemoryExperienceModel(ctx.serverDB, ctx.userId),
      identityModel: new UserMemoryIdentityModel(ctx.serverDB, ctx.userId),
      personaModel: new UserPersonaModel(ctx.serverDB, ctx.userId),
      preferenceModel: new UserMemoryPreferenceModel(ctx.serverDB, ctx.userId),
      topicModel: new TopicModel(ctx.serverDB, ctx.userId, wsId),
      userMemoryModel: new UserMemoryModel(ctx.serverDB, ctx.userId),
    },
  });
});
const userMemoryWriteProcedure = userMemoryProcedure.use(withScopedPermission('message:create'));
const personalUserMemoryProcedure = userMemoryProcedure.use(async ({ ctx, next }) => {
  if (ctx.workspaceId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Persona versions are available only in personal scope',
    });
  }
  return next();
});
const personalUserMemoryWriteProcedure = personalUserMemoryProcedure.use(
  withScopedPermission('message:create'),
);

const userMemoryExtractionInputSchema = z.object({
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
});

const userMemoryExtractionTaskInputSchema = z
  .object({
    taskId: z.string().uuid().optional(),
  })
  .optional();

// NOTICE(@nekomeowww): Memory extraction time scales with topic count. We estimate
// an average of ~5 minutes per topic to derive a dynamic timeout budget.
const USER_MEMORY_EXTRACTION_TIMEOUT_PER_TOPIC_MS = 5 * 60 * 1000;

const getUserMemoryExtractionTimeoutMs = (metadata: UserMemoryExtractionMetadata) => {
  const totalTopics = metadata.progress.totalTopics;

  if (!Number.isFinite(totalTopics) || !totalTopics || totalTopics <= 0) return null;

  return totalTopics * USER_MEMORY_EXTRACTION_TIMEOUT_PER_TOPIC_MS;
};

export const userMemoryRouter = router({
  // ============ Identity CRUD ============
  createIdentity: userMemoryWriteProcedure
    .input(CreateUserMemoryIdentitySchema)
    .mutation(async ({ ctx, input }) => {
      return ctx.userMemoryModel.addIdentityEntry({
        base: {},
        identity: {
          description: input.description,
          episodicDate: input.episodicDate,
          relationship: input.relationship,
          role: input.role,
          tags: input.extractedLabels,
          type: input.type,
        },
      });
    }),

  // ============ Activity CRUD ============
  deleteActivity: userMemoryWriteProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.activityModel.delete(input.id);
    }),

  deleteAll: userMemoryWriteProcedure.mutation(async ({ ctx }) => {
    await ctx.userMemoryModel.deleteAll();
    await ctx.personaModel.deletePersona();

    return { success: true };
  }),

  // ============ Context CRUD ============
  deleteContext: userMemoryWriteProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.contextModel.delete(input.id);
    }),

  // ============ Experience CRUD ============
  deleteExperience: userMemoryWriteProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.experienceModel.delete(input.id);
    }),

  deleteIdentity: userMemoryWriteProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.userMemoryModel.removeIdentityEntry(input.id);
    }),

  // ============ Preference CRUD ============
  deletePreference: userMemoryWriteProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.preferenceModel.delete(input.id);
    }),

  getActivities: userMemoryProcedure.query(async ({ ctx }) => {
    return ctx.userMemoryModel.searchActivities({});
  }),

  getContexts: userMemoryProcedure.query(async ({ ctx }) => {
    return ctx.userMemoryModel.searchContexts({});
  }),

  getExperiences: userMemoryProcedure.query(async ({ ctx }) => {
    return ctx.userMemoryModel.searchExperiences({});
  }),

  getIdentities: userMemoryProcedure.query(async ({ ctx }) => {
    return ctx.userMemoryModel.getAllIdentities();
  }),

  getMemoryExtractionTask: userMemoryProcedure
    .input(userMemoryExtractionTaskInputSchema)
    .query(async ({ ctx, input }) => {
      const task = input?.taskId
        ? await ctx.asyncTaskModel.findById(input.taskId)
        : await ctx.asyncTaskModel.findActiveByType(
            AsyncTaskType.UserMemoryExtractionWithChatTopic,
          );

      if (!task || task.userId !== ctx.userId) return null;

      const metadata = initUserMemoryExtractionMetadata(
        task.metadata as UserMemoryExtractionMetadata | undefined,
      );

      const timeoutMs = getUserMemoryExtractionTimeoutMs(metadata);
      const taskCreatedAt = task.createdAt ? new Date(task.createdAt).getTime() : Number.NaN;
      const isActiveTask =
        task.status === AsyncTaskStatus.Pending || task.status === AsyncTaskStatus.Processing;

      if (
        isActiveTask &&
        timeoutMs !== null &&
        Number.isFinite(taskCreatedAt) &&
        Date.now() - taskCreatedAt > timeoutMs
      ) {
        const timeoutMinutes = Math.ceil(timeoutMs / (60 * 1000));
        const timeoutError = new AsyncTaskError(
          AsyncTaskErrorType.Timeout,
          `User memory extraction timed out after ${timeoutMinutes} minutes for ${metadata.progress.totalTopics} topics (estimated at 5 minutes per topic). Please retry.`,
        );

        await ctx.asyncTaskModel.update(task.id, {
          error: timeoutError,
          status: AsyncTaskStatus.Error,
        });

        return {
          error: timeoutError,
          id: task.id,
          metadata,
          status: AsyncTaskStatus.Error,
        };
      }

      return {
        error: task.error,
        id: task.id,
        metadata,
        status: task.status as AsyncTaskStatus,
      };
    }),

  // ============ Persona ============
  getPersona: userMemoryProcedure.query(async ({ ctx }) => {
    const latest = await ctx.personaModel.getLatestPersonaDocument();

    if (!latest) return null;

    return {
      content: latest.persona ?? '',
      summary: latest.tagline ?? '',
    };
  }),

  listPersonaVersions: personalUserMemoryProcedure.query(async ({ ctx }) => {
    return ctx.personaModel.listVersions();
  }),

  getPreferences: userMemoryProcedure.query(async ({ ctx }) => {
    return ctx.userMemoryModel.searchPreferences({});
  }),

  requestMemoryFromChatTopic: userMemoryWriteProcedure
    .input(userMemoryExtractionInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.fromDate && input.toDate && input.fromDate > input.toDate) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: '`fromDate` cannot be later than `toDate`',
        });
      }

      const existingTask = await ctx.asyncTaskModel.findActiveByType(
        AsyncTaskType.UserMemoryExtractionWithChatTopic,
      );
      if (existingTask) {
        return {
          deduped: true,
          id: existingTask.id,
          metadata: existingTask.metadata as UserMemoryExtractionMetadata,
          status: existingTask.status as AsyncTaskStatus,
        };
      }

      const totalTopics = await ctx.topicModel.countTopicsForMemoryExtractor({
        endDate: input.toDate,
        ignoreExtracted: false,
        startDate: input.fromDate,
      });
      const metadata = initUserMemoryExtractionMetadata({
        progress: {
          completedTopics: 0,
          totalTopics,
        },
        range: {
          from: input.fromDate?.toISOString(),
          to: input.toDate?.toISOString(),
        },
        source: 'chat_topic',
      });

      const initialStatus = totalTopics === 0 ? AsyncTaskStatus.Success : AsyncTaskStatus.Pending;
      const taskId = await ctx.asyncTaskModel.create({
        metadata,
        status: initialStatus,
        type: AsyncTaskType.UserMemoryExtractionWithChatTopic,
      });

      if (totalTopics === 0) {
        return {
          deduped: false,
          id: taskId,
          metadata: metadata as UserMemoryExtractionMetadata,
          status: initialStatus as AsyncTaskStatus,
        };
      }

      const { webhook, upstashWorkflowExtraHeaders } = parseMemoryExtractionConfig();
      const baseUrl = webhook.baseUrl || appEnv.INTERNAL_APP_URL || appEnv.APP_URL;

      try {
        const MAX_TOPICS = 10;
        console.log(
          '[memory-extraction] starting direct extraction for user',
          ctx.userId,
          'range:',
          input.fromDate,
          '~',
          input.toDate,
        );

        // 1. 创建 executor
        const executor = await MemoryExtractionExecutor.create();

        // 2. 获取用户的话题列表（按日期范围）
        const topicBatch = await executor.getTopicsForUser(
          {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            from: input.fromDate,
            to: input.toDate,
            forceAll: false,
            forceTopics: false,
          },
          MAX_TOPICS,
        );

        // 3. 没有话题可处理
        if (topicBatch.ids.length === 0) {
          console.log('[memory-extraction] no topics to process for user', ctx.userId);
          await ctx.asyncTaskModel.update(taskId, { metadata: {
              ...metadata,
              progress: { completedTopics: 0, totalTopics },
            } as UserMemoryExtractionMetadata,
            status: AsyncTaskStatus.Success,
          });
          return {
            deduped: false,
            id: taskId,
            metadata: metadata as UserMemoryExtractionMetadata,
            status: AsyncTaskStatus.Success as AsyncTaskStatus,
          };
        }

        // 4. 逐个处理话题（带错误隔离）
        const processedTopics: string[] = [];
        const failedTopics: { topicId: string; error: string }[] = [];

        for (const topicId of topicBatch.ids) {
          try {
            console.log('[memory-extraction] processing topic', topicId, '...');
            const extracted = await executor.extractTopic({
              topicId,
              userId: ctx.userId,
              workspaceId: ctx.workspaceId,
              source: MemorySourceType.ChatTopic,
              layers: [],
              forceAll: false,
              forceTopics: false,
              from: input.fromDate,
              to: input.toDate,
              asyncTaskId: taskId,
              userInitiated: true,
              reportProgress: true,
            });
            processedTopics.push(topicId);
            console.log(
              '[memory-extraction] topic',
              topicId,
              'done: extracted=',
              extracted.extracted,
              'memoryIds=',
              extracted.memoryIds.length,
            );
          } catch (error) {
            console.error('[memory-extraction] topic', topicId, 'FAILED:', error);
            failedTopics.push({ topicId, error: String(error) });
          }
        }

        // 5. 更新 async_task 状态
        const finalStatus =
          failedTopics.length > processedTopics.length
            ? AsyncTaskStatus.Error
            : AsyncTaskStatus.Success;

        await ctx.asyncTaskModel.update(taskId, { metadata: {
            ...metadata,
            progress: { completedTopics: processedTopics.length, totalTopics },
          } as UserMemoryExtractionMetadata,
          status: finalStatus,
        });

        console.log(
          '[memory-extraction] extraction complete:',
          processedTopics.length,
          'ok,',
          failedTopics.length,
          'failed',
        );
        if (failedTopics.length > 0) {
          console.error('[memory-extraction] failed details:', JSON.stringify(failedTopics));
        }

        return {
          deduped: false,
          id: taskId,
          metadata: metadata as UserMemoryExtractionMetadata,
          status: finalStatus as AsyncTaskStatus,
        };
      } catch (error) {
        console.error('[memory-extraction] FATAL error in requestMemoryFromChatTopic:', error);
        await ctx.asyncTaskModel.update(taskId, {
          error: new AsyncTaskError(
            AsyncTaskErrorType.TaskTriggerError,
            'Failed to execute memory extraction: ' +
              (error instanceof Error ? error.message : String(error)),
          ),
          status: AsyncTaskStatus.Error,
        });
        throw new TRPCError({
          cause: error,
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to trigger user memory extraction',
        });
      }
    }),

  restorePersonaVersion: personalUserMemoryWriteProcedure
    .input(z.object({ historyId: z.string().trim().min(1).max(255) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const { document } = await ctx.personaModel.restoreVersion(input.historyId);
        return { historyId: input.historyId, personaVersion: document.version };
      } catch (error) {
        if (error instanceof UserPersonaVersionNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Persona version was not found' });
        }
        if (error instanceof UserPersonaVersionSnapshotMissingError) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Persona version snapshot is unavailable',
          });
        }
        throw error;
      }
    }),

  updateActivity: userMemoryWriteProcedure
    .input(
      z.object({
        data: z.object({
          narrative: z.string().optional(),
          notes: z.string().optional(),
          status: z.string().optional(),
        }),
        id: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.activityModel.update(input.id, input.data);
    }),

  updateContext: userMemoryWriteProcedure
    .input(
      z.object({
        data: z.object({
          currentStatus: z.string().optional(),
          description: z.string().optional(),
          title: z.string().optional(),
        }),
        id: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.contextModel.update(input.id, input.data);
    }),

  updateExperience: userMemoryWriteProcedure
    .input(
      z.object({
        data: z.object({
          action: z.string().optional(),
          keyLearning: z.string().optional(),
          situation: z.string().optional(),
        }),
        id: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.experienceModel.update(input.id, input.data);
    }),

  updateIdentity: userMemoryWriteProcedure
    .input(
      z.object({
        data: UpdateUserMemoryIdentitySchema,
        id: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.userMemoryModel.updateIdentityEntry({
        identity: {
          description: input.data.description,
          episodicDate: input.data.episodicDate,
          relationship: input.data.relationship,
          role: input.data.role,
          tags: input.data.extractedLabels,
          type: input.data.type,
        },
        identityId: input.id,
      });
    }),

  updatePreference: userMemoryWriteProcedure
    .input(
      z.object({
        data: z.object({
          conclusionDirectives: z.string().optional(),
          suggestions: z.string().optional(),
        }),
        id: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.preferenceModel.update(input.id, input.data);
    }),
});

export type UserMemoryRouter = typeof userMemoryRouter;
