import { z } from 'zod';

import { createBoundedJsonObjectSchema } from './common.js';
import {
  commandIdSchema,
  operationIdSchema,
  runIdSchema,
  threadIdSchema,
} from './ids.js';

export const errorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'THREAD_NOT_FOUND',
  'THREAD_ARCHIVED',
  'THREAD_DELETED',
  'THREAD_PURGE_STARTED',
  'THREAD_NOT_IMMEDIATELY_RUNNABLE',
  'RUN_NOT_FOUND',
  'RUN_NOT_ACTIVE',
  'RUN_ALREADY_TERMINAL',
  'STALE_PLAN_GENERATION',
  'STALE_INCARNATION',
  'QUEUE_ITEM_NOT_FOUND',
  'QUEUE_ITEM_ALREADY_CONSUMED',
  'QUEUE_REVISION_CONFLICT',
  'COMMAND_ID_CONFLICT',
  'APPROVAL_EXPIRED',
  'OPERATION_CONFLICT',
  'CONFIG_REVISION_CONFLICT',
  'POLICY_REVISION_CONFLICT',
  'RUNTIME_DRAINING',
  'RECOVERY_BLOCKED',
  'INDETERMINATE_SIDE_EFFECT',
  'AUTHENTICATION_REQUIRED',
  'CREDENTIAL_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

const apiErrorDetailsSchema = createBoundedJsonObjectSchema(65_536, 10_000);

export const apiErrorPayloadSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().trim().min(1),
  commandId: commandIdSchema.optional(),
  threadId: threadIdSchema.optional(),
  runId: runIdSchema.optional(),
  operationId: operationIdSchema.optional(),
  retryable: z.boolean(),
  details: apiErrorDetailsSchema.optional(),
});
export type ApiErrorPayload = z.infer<typeof apiErrorPayloadSchema>;

export const apiErrorSchema = z.strictObject({
  error: apiErrorPayloadSchema,
});
export type ApiError = z.infer<typeof apiErrorSchema>;

const errorCategorySchema = z.enum([
  'validation',
  'authentication',
  'notFound',
  'conflict',
  'gone',
  'semantic',
  'unavailable',
  'internal',
]);

const errorHttpMappingEntrySchema = z.strictObject({
  code: errorCodeSchema,
  httpStatus: z.union([
    z.literal(400),
    z.literal(401),
    z.literal(404),
    z.literal(409),
    z.literal(410),
    z.literal(422),
    z.literal(500),
    z.literal(503),
  ]),
  retryableDefault: z.boolean(),
  category: errorCategorySchema,
});

type ErrorHttpMapping = z.infer<typeof errorHttpMappingEntrySchema>;

const errorHttpMappingByCode = {
  VALIDATION_ERROR: {
    httpStatus: 400,
    retryableDefault: false,
    category: 'validation',
  },
  THREAD_NOT_FOUND: {
    httpStatus: 404,
    retryableDefault: false,
    category: 'notFound',
  },
  THREAD_ARCHIVED: {
    httpStatus: 422,
    retryableDefault: false,
    category: 'semantic',
  },
  THREAD_DELETED: {
    httpStatus: 410,
    retryableDefault: false,
    category: 'gone',
  },
  THREAD_PURGE_STARTED: {
    httpStatus: 410,
    retryableDefault: false,
    category: 'gone',
  },
  THREAD_NOT_IMMEDIATELY_RUNNABLE: {
    httpStatus: 422,
    retryableDefault: false,
    category: 'semantic',
  },
  RUN_NOT_FOUND: {
    httpStatus: 404,
    retryableDefault: false,
    category: 'notFound',
  },
  RUN_NOT_ACTIVE: {
    httpStatus: 409,
    retryableDefault: false,
    category: 'conflict',
  },
  RUN_ALREADY_TERMINAL: {
    httpStatus: 409,
    retryableDefault: false,
    category: 'conflict',
  },
  STALE_PLAN_GENERATION: {
    httpStatus: 409,
    retryableDefault: false,
    category: 'conflict',
  },
  STALE_INCARNATION: {
    httpStatus: 409,
    retryableDefault: false,
    category: 'conflict',
  },
  QUEUE_ITEM_NOT_FOUND: {
    httpStatus: 404,
    retryableDefault: false,
    category: 'notFound',
  },
  QUEUE_ITEM_ALREADY_CONSUMED: {
    httpStatus: 409,
    retryableDefault: false,
    category: 'conflict',
  },
  QUEUE_REVISION_CONFLICT: {
    httpStatus: 409,
    retryableDefault: false,
    category: 'conflict',
  },
  COMMAND_ID_CONFLICT: {
    httpStatus: 409,
    retryableDefault: false,
    category: 'conflict',
  },
  APPROVAL_EXPIRED: {
    httpStatus: 409,
    retryableDefault: false,
    category: 'conflict',
  },
  OPERATION_CONFLICT: {
    httpStatus: 409,
    retryableDefault: false,
    category: 'conflict',
  },
  CONFIG_REVISION_CONFLICT: {
    httpStatus: 409,
    retryableDefault: false,
    category: 'conflict',
  },
  POLICY_REVISION_CONFLICT: {
    httpStatus: 409,
    retryableDefault: false,
    category: 'conflict',
  },
  RUNTIME_DRAINING: {
    httpStatus: 503,
    retryableDefault: false,
    category: 'unavailable',
  },
  RECOVERY_BLOCKED: {
    httpStatus: 503,
    retryableDefault: false,
    category: 'unavailable',
  },
  INDETERMINATE_SIDE_EFFECT: {
    httpStatus: 422,
    retryableDefault: false,
    category: 'semantic',
  },
  AUTHENTICATION_REQUIRED: {
    httpStatus: 401,
    retryableDefault: false,
    category: 'authentication',
  },
  CREDENTIAL_UNAVAILABLE: {
    httpStatus: 503,
    retryableDefault: false,
    category: 'unavailable',
  },
  INTERNAL_ERROR: {
    httpStatus: 500,
    retryableDefault: false,
    category: 'internal',
  },
} as const satisfies Readonly<
  Record<ErrorCode, Omit<ErrorHttpMapping, 'code'>>
>;

export const errorHttpMappings = Object.freeze(
  errorCodeSchema.options.map((code) =>
    Object.freeze({ code, ...errorHttpMappingByCode[code] }),
  ),
);

export const errorCodeHttpStatus = Object.freeze({
  VALIDATION_ERROR: errorHttpMappingByCode.VALIDATION_ERROR.httpStatus,
  THREAD_NOT_FOUND: errorHttpMappingByCode.THREAD_NOT_FOUND.httpStatus,
  THREAD_ARCHIVED: errorHttpMappingByCode.THREAD_ARCHIVED.httpStatus,
  THREAD_DELETED: errorHttpMappingByCode.THREAD_DELETED.httpStatus,
  THREAD_PURGE_STARTED: errorHttpMappingByCode.THREAD_PURGE_STARTED.httpStatus,
  THREAD_NOT_IMMEDIATELY_RUNNABLE:
    errorHttpMappingByCode.THREAD_NOT_IMMEDIATELY_RUNNABLE.httpStatus,
  RUN_NOT_FOUND: errorHttpMappingByCode.RUN_NOT_FOUND.httpStatus,
  RUN_NOT_ACTIVE: errorHttpMappingByCode.RUN_NOT_ACTIVE.httpStatus,
  RUN_ALREADY_TERMINAL: errorHttpMappingByCode.RUN_ALREADY_TERMINAL.httpStatus,
  STALE_PLAN_GENERATION:
    errorHttpMappingByCode.STALE_PLAN_GENERATION.httpStatus,
  STALE_INCARNATION: errorHttpMappingByCode.STALE_INCARNATION.httpStatus,
  QUEUE_ITEM_NOT_FOUND: errorHttpMappingByCode.QUEUE_ITEM_NOT_FOUND.httpStatus,
  QUEUE_ITEM_ALREADY_CONSUMED:
    errorHttpMappingByCode.QUEUE_ITEM_ALREADY_CONSUMED.httpStatus,
  QUEUE_REVISION_CONFLICT:
    errorHttpMappingByCode.QUEUE_REVISION_CONFLICT.httpStatus,
  COMMAND_ID_CONFLICT: errorHttpMappingByCode.COMMAND_ID_CONFLICT.httpStatus,
  APPROVAL_EXPIRED: errorHttpMappingByCode.APPROVAL_EXPIRED.httpStatus,
  OPERATION_CONFLICT: errorHttpMappingByCode.OPERATION_CONFLICT.httpStatus,
  CONFIG_REVISION_CONFLICT:
    errorHttpMappingByCode.CONFIG_REVISION_CONFLICT.httpStatus,
  POLICY_REVISION_CONFLICT:
    errorHttpMappingByCode.POLICY_REVISION_CONFLICT.httpStatus,
  RUNTIME_DRAINING: errorHttpMappingByCode.RUNTIME_DRAINING.httpStatus,
  RECOVERY_BLOCKED: errorHttpMappingByCode.RECOVERY_BLOCKED.httpStatus,
  INDETERMINATE_SIDE_EFFECT:
    errorHttpMappingByCode.INDETERMINATE_SIDE_EFFECT.httpStatus,
  AUTHENTICATION_REQUIRED:
    errorHttpMappingByCode.AUTHENTICATION_REQUIRED.httpStatus,
  CREDENTIAL_UNAVAILABLE:
    errorHttpMappingByCode.CREDENTIAL_UNAVAILABLE.httpStatus,
  INTERNAL_ERROR: errorHttpMappingByCode.INTERNAL_ERROR.httpStatus,
} as const satisfies Readonly<
  Record<ErrorCode, ErrorHttpMapping['httpStatus']>
>);

export const errorHttpMappingSchema = z.array(errorHttpMappingEntrySchema);
export type ErrorHttpMappings = z.infer<typeof errorHttpMappingSchema>;
