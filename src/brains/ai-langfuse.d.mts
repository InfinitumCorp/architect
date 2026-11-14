export declare const LANGFUSE_CLIENT_VERSION: string;
export interface LangfuseGeneration {
  name: string;
  model?: string;
  startMs: number;
  endMs: number;
  usage?: { input?: number; output?: number };
  error?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, string | number | boolean | undefined | null>;
}
export interface LangfuseTracer {
  product?: string;
  captureContent: boolean;
  record(generation: LangfuseGeneration): Promise<void>;
}
export declare function generationSpan(g: LangfuseGeneration & { product?: string; environment?: string }): unknown;
export declare function langfuseFromEnv(env?: Record<string, string | undefined>, options?: { product?: string; fetch?: typeof fetch; timeoutMs?: number }): LangfuseTracer | null;
export declare function tracedAI<T>(ai: T, tracer: LangfuseTracer | null, options?: { waitUntil?: (p: Promise<unknown>) => void; name?: string }): T;
