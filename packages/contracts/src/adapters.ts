import { z } from 'zod';
import {
  LanguageSchema,
  type HealthStatus,
  type Language,
  type Locality,
  type Modality,
  type ModelInfo,
} from './common.js';

/* ------------------------------------------------------------------ */
/* Capabilities per modality                                           */
/* ------------------------------------------------------------------ */

export const TextCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  /** Can take audio input directly (Gemma 4 via `input_audio`). Does not replace the STT adapter. */
  audioInput: z.boolean(),
  maxContextTokens: z.number().int().positive(),
  languages: z.array(LanguageSchema),
});
export const SttCapabilitiesSchema = z.object({
  languageDetection: z.boolean(),
  /** Hard limit of one clip, seconds (Gemma audio: 30). */
  maxClipSeconds: z.number().positive(),
  inputFormats: z.array(z.string()),
  languages: z.array(LanguageSchema),
});
export const TtsCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  outputFormat: z.enum(['wav', 'mp3']),
  sampleRateHz: z.number().int().positive(),
  languages: z.array(LanguageSchema),
  /** Sends text to a third party (ElevenLabs). Shown in UI, forbidden in Offline profile. */
  sendsTextToCloud: z.boolean(),
});
export const ImageCapabilitiesSchema = z.object({
  /** Generation returns a job that must be polled (ComfyUI). */
  async: z.boolean(),
  maxWidth: z.number().int().positive(),
  maxHeight: z.number().int().positive(),
  outputFormat: z.enum(['png', 'jpeg', 'svg']),
});

export type TextCapabilities = z.infer<typeof TextCapabilitiesSchema>;
export type SttCapabilities = z.infer<typeof SttCapabilitiesSchema>;
export type TtsCapabilities = z.infer<typeof TtsCapabilitiesSchema>;
export type ImageCapabilities = z.infer<typeof ImageCapabilitiesSchema>;

export interface CapabilitiesByModality {
  text: TextCapabilities;
  stt: SttCapabilities;
  tts: TtsCapabilities;
  image: ImageCapabilities;
}

/* ------------------------------------------------------------------ */
/* Base adapter                                                        */
/* ------------------------------------------------------------------ */

export interface CallOptions {
  signal?: AbortSignal;
}

/**
 * Every engine implements this. The learning loop never knows checkpoints or SDKs —
 * only this contract. Model, endpoint, voice and limits come from `config/engines.json`.
 */
export interface EngineAdapter<M extends Modality = Modality> {
  readonly modality: M;
  /** Provider id, matches the key in `config/engines.json` (`fake`, `ollama`, `whisper-cpp`, ...). */
  readonly provider: string;
  readonly locality: Locality;
  /** Holds a large model in memory → must go through the dispatcher. */
  readonly heavy: boolean;
  health(opts?: CallOptions): Promise<HealthStatus>;
  listModels(opts?: CallOptions): Promise<ModelInfo[]>;
  capabilities(): CapabilitiesByModality[M];
  /** Free memory held by `model` (e.g. `ollama stop`). Called by the dispatcher before another heavy engine runs. */
  unload?(model: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

export const ChatRoleSchema = z.enum(['system', 'user', 'assistant']);
export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const TextRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  maxTokens: z.number().int().positive().default(256),
  temperature: z.number().min(0).max(2).default(0.3),
  /** Ask for a JSON object (Ollama `format: json`). */
  json: z.boolean().default(false),
  /** Reasoning off by default: tech recon measured latency with thinking disabled. */
  think: z.boolean().default(false),
  /** Opaque context for providers that want structure (fake engine reads the rubric from here). */
  context: z.record(z.string(), z.unknown()).optional(),
});
export type TextRequest = z.input<typeof TextRequestSchema>;

export const TextUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  loadMs: z.number().nonnegative().optional(),
  totalMs: z.number().nonnegative().optional(),
});

export type TextStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; model: string; usage?: z.infer<typeof TextUsageSchema> };

export interface TextResult {
  text: string;
  model: string;
  usage?: z.infer<typeof TextUsageSchema>;
}

export interface TextAdapter extends EngineAdapter<'text'> {
  /** Stream of deltas that always ends with exactly one `done` event, or throws `EngineError`. */
  stream(req: TextRequest, opts?: CallOptions): AsyncIterable<TextStreamEvent>;
}

/** Collect a text stream into its final result. */
export async function collectText(events: AsyncIterable<TextStreamEvent>): Promise<TextResult> {
  for await (const ev of events) {
    if (ev.type === 'done') return { text: ev.text, model: ev.model, usage: ev.usage };
  }
  throw new Error('text stream ended without a done event');
}

/* ------------------------------------------------------------------ */
/* STT                                                                 */
/* ------------------------------------------------------------------ */

export interface SttRequest {
  model: string;
  audio: Uint8Array;
  /** MIME of `audio` as recorded by the browser: `audio/webm`, `audio/mp4`, `audio/wav`. Backend normalises to 16 kHz mono WAV. */
  mimeType: string;
  /** Expected language or `auto`. */
  language: Language | 'auto';
  /** Optional hint, e.g. the card question, to bias recognition. */
  prompt?: string;
}

export const TranscriptSchema = z.object({
  text: z.string(),
  language: LanguageSchema.nullable(),
  durationSec: z.number().nonnegative(),
  /** 0..1 if the engine reports it. Low confidence → the UI asks "I heard: … — correct?". */
  confidence: z.number().min(0).max(1).nullable(),
  model: z.string(),
  segments: z.array(z.object({ startSec: z.number(), endSec: z.number(), text: z.string() })).optional(),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

export interface SttAdapter extends EngineAdapter<'stt'> {
  /** Throws `EngineError('no_speech')` on silence — that is "no answer received", not a wrong answer. */
  transcribe(req: SttRequest, opts?: CallOptions): Promise<Transcript>;
}

/* ------------------------------------------------------------------ */
/* TTS                                                                 */
/* ------------------------------------------------------------------ */

export const TtsRequestSchema = z.object({
  model: z.string().min(1),
  text: z.string().min(1).max(2000),
  language: LanguageSchema,
  voice: z.string().optional(),
  /** Speaking style hint for instruct-capable models ("calm, warm narrator"). */
  instruct: z.string().optional(),
});
export type TtsRequest = z.infer<typeof TtsRequestSchema>;

export interface TtsResult {
  audio: Uint8Array;
  mimeType: 'audio/wav' | 'audio/mpeg';
  durationSec: number;
  model: string;
  voice: string | null;
}

export interface TtsAdapter extends EngineAdapter<'tts'> {
  synthesize(req: TtsRequest, opts?: CallOptions): Promise<TtsResult>;
}

/* ------------------------------------------------------------------ */
/* Image                                                               */
/* ------------------------------------------------------------------ */

export const ImageRequestSchema = z.object({
  model: z.string().min(1),
  /** What to depict (the causal scheme of the card). */
  topic: z.string().min(1),
  /** Student's world: `fantasy`, `cyberpunk`, `anime`, `sport`, ... */
  style: z.string().min(1),
  width: z.number().int().positive().default(1024),
  height: z.number().int().positive().default(1024),
  steps: z.number().int().positive().optional(),
  seed: z.number().int().optional(),
  /** Never put text in the picture: generators render it badly. */
  negative: z.string().optional(),
});
export type ImageRequest = z.input<typeof ImageRequestSchema>;

export const ImageJobStateSchema = z.enum(['queued', 'running', 'done', 'failed']);
export const ImageJobSchema = z.object({
  jobId: z.string(),
  state: ImageJobStateSchema,
  /** Local file path or `/media/...` URL served by our server; present when `done`. */
  file: z.string().nullable(),
  mimeType: z.string().nullable(),
  error: z.string().nullable(),
  progress: z.number().min(0).max(1).nullable(),
});
export type ImageJob = z.infer<typeof ImageJobSchema>;

export interface ImageAdapter extends EngineAdapter<'image'> {
  /** Returns a job; synchronous providers return it already `done`. */
  generate(req: ImageRequest, opts?: CallOptions): Promise<ImageJob>;
  getJob(jobId: string, opts?: CallOptions): Promise<ImageJob>;
}

export interface AdapterByModality {
  text: TextAdapter;
  stt: SttAdapter;
  tts: TtsAdapter;
  image: ImageAdapter;
}
