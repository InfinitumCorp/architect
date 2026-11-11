// Types for openclaw.mjs. Source of truth: InfinitumCorp/infinitum-nexus packages/ai/src/openclaw.

export declare const OPENCLAW_CLIENT_VERSION: string;
export declare const OPENCLAW_NOT_CONNECTED: string;
export declare const OPENCLAW_NEEDS_TASK: string;

export declare class OpenClawError extends Error {
  readonly status: number;
  constructor(message: string, status: number);
}

export declare function parseOpenClawMention(text: unknown): { task: string } | null;
export declare function hasOpenClawMention(text: unknown): boolean;

export interface OpenClawOptions {
  /** Gateway base URL, for example https://claw.example.ts.net. https unless it is localhost. */
  url: string;
  /** Gateway bearer token (gateway.auth.token). A server secret. */
  token: string;
  /** "openclaw" (default agent) or "openclaw/<agentId>". */
  agent?: string;
  /** Milliseconds to wait for the agent (default 120000). */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Product name used in error messages. */
  product?: string;
}

export interface AskOptions {
  /** Keeps one OpenClaw session per person, e.g. "scalvs:<cid>". */
  user?: string;
  /** Background the agent should know (sent as the system message). */
  context?: string;
  signal?: AbortSignal;
}

export interface OpenClawClient {
  readonly agent: string;
  ask(task: string, opts?: AskOptions): Promise<string>;
  /** Null when the text has no @scalvs / @scalus. Throws OpenClawError(400) for a bare mention. */
  handleMention(text: string, opts?: AskOptions): Promise<{ text: string; agent: string } | null>;
}

export declare function createOpenClaw(options: OpenClawOptions): OpenClawClient;

export type OpenClawRouteHandler = (
  request: Request,
  who?: { user?: string | null; context?: string },
) => Promise<Response | null>;

export interface OpenClawRoutesOptions {
  /** A client, null (off), or a per-user lookup for people who bring their own gateway. */
  openclaw?: OpenClawClient | null | ((user: string) => OpenClawClient | null | Promise<OpenClawClient | null>);
  /** Default "/api/openclaw". */
  prefix?: string;
  /** Prefix of the OpenClaw `user` field, e.g. "scalvs". */
  product?: string;
}

export declare function createOpenClawRoutes(options?: OpenClawRoutesOptions): OpenClawRouteHandler;
export declare function toWebRequest(req: import("node:http").IncomingMessage, base?: string): Promise<Request>;
export declare function sendWebResponse(res: import("node:http").ServerResponse, response: Response): Promise<void>;
export declare function openClawFromEnv(env?: Record<string, string | undefined>, options?: Partial<OpenClawOptions>): OpenClawClient | null;
export declare function openClawRoutesFromEnv(
  env?: Record<string, string | undefined>,
  options?: { product?: string; prefix?: string; fetch?: typeof fetch; timeoutMs?: number },
): OpenClawRouteHandler;
