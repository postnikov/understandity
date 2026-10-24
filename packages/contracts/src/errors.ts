import { z } from 'zod';
import { ModalitySchema, type Modality } from './common.js';

/**
 * Explicit error codes every adapter may raise. Never hide a failure behind a silent fallback:
 * the caller decides what to do (show text instead of audio, ask to re-record, ...).
 */
export const EngineErrorCodeSchema = z.enum([
  'unavailable', // process/endpoint not reachable
  'model_missing', // requested model is not installed
  'busy', // dispatcher is running another heavy task and the caller did not want to queue
  'timeout',
  'cancelled',
  'offline_forbidden', // a cloud provider was called while the Offline profile is active
  'bad_input', // e.g. empty audio, clip longer than 30 s, unsupported format
  'unsupported', // capability not offered by this provider (language, streaming, ...)
  'no_speech', // STT heard silence / noise: "answer not received", NOT "did not understand"
  'not_implemented',
  'internal',
]);
export type EngineErrorCode = z.infer<typeof EngineErrorCodeSchema>;

export const EngineErrorPayloadSchema = z.object({
  modality: ModalitySchema.nullable(),
  provider: z.string().nullable(),
  code: EngineErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
export type EngineErrorPayload = z.infer<typeof EngineErrorPayloadSchema>;

const RETRYABLE: ReadonlySet<EngineErrorCode> = new Set(['unavailable', 'busy', 'timeout', 'no_speech']);

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly modality: Modality | null;
  readonly provider: string | null;
  readonly retryable: boolean;

  constructor(
    code: EngineErrorCode,
    message: string,
    opts: { modality?: Modality | null; provider?: string | null; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'EngineError';
    this.code = code;
    this.modality = opts.modality ?? null;
    this.provider = opts.provider ?? null;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
  }

  toPayload(): EngineErrorPayload {
    return {
      modality: this.modality,
      provider: this.provider,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }

  static is(err: unknown): err is EngineError {
    return err instanceof EngineError;
  }
}
