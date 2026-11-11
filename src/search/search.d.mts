// Types for search.mjs (Infinitum Search). Source of truth: InfinitumCorp/infinitum-nexus packages/ai/src/search.

export declare const SEARCH_CLIENT_VERSION: string;
export declare const SEARCH_USER_AGENT: string;
export declare const SEARCH_NOT_CONNECTED: string;
export declare const SEARCH_NEEDS_QUERY: string;

export declare class SearchError extends Error {
  status: number;
  constructor(message: string, status: number);
}

export interface SearchResult { title: string; url: string; snippet: string }
export interface SearchEngine { name: string; search(query: string, options?: { language?: string; signal?: AbortSignal }): Promise<SearchResult[]> }
export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export type Chat = (messages: ChatMessage[], options?: { signal?: AbortSignal }) => Promise<string>;
export interface Source { n: number; title: string; url: string; snippet: string }
export interface SearchAnswer {
  query: string;
  /** Null when no answer model is configured or it failed; the sources still come back. */
  answer: string | null;
  /** Source numbers the answer cites. */
  cited: number[];
  sources: Source[];
  engine: string;
  /** How many pages were read. */
  read: number;
}
export interface CrawledPage { url: string; title: string; description: string; text: string }

export declare function parseSearchMention(text: unknown): { query: string } | null;
export declare function hasSearchMention(text: unknown): boolean;
export declare function decodeEntities(s: string): string;
export declare function isPublicUrl(url: string): boolean;
export declare function extractText(html: string): { title: string; description: string; text: string };
export interface RobotsRules { group: "specific" | "global" | "none"; allow: string[]; disallow: string[] }
/** robots.txt rules for our agent(s), following Google's open-source parser (google/robotstxt, Apache-2.0). */
export declare function parseRobots(txt: string, agents?: string | string[]): RobotsRules;
export declare function robotsAllows(rules: Pick<RobotsRules, "allow" | "disallow">, path: string): boolean;
export declare function robotsPatternMatches(path: string, pattern: string): boolean;
export declare function robotsPath(url: string): string;
export declare function escapeRobotsPattern(value: string): string;
export declare function createCrawler(options?: { fetch?: typeof fetch; timeoutMs?: number; robots?: boolean; userAgent?: string }): (url: string, options?: { signal?: AbortSignal }) => Promise<CrawledPage | null>;
export declare function searxngEngine(options: { url: string; fetch?: typeof fetch; timeoutMs?: number }): SearchEngine;
export declare function yandexEngine(options: { apiKey: string; folderId: string; fetch?: typeof fetch; timeoutMs?: number }): SearchEngine;
export declare function braveEngine(options: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number }): SearchEngine;
export declare function parseYandexXml(xml: string): SearchResult[];
export declare function openAiChat(options: { baseUrl: string; apiKey?: string; model?: string; fetch?: typeof fetch; timeoutMs?: number }): Chat;
export declare function checkCitations(answer: string, count: number): { text: string; used: number[] };

export interface Search {
  engines: string[];
  answers: boolean;
  ask(query: string, options?: { context?: string; language?: string; signal?: AbortSignal }): Promise<SearchAnswer>;
  handleMention(text: string, options?: { context?: string; language?: string; signal?: AbortSignal }): Promise<SearchAnswer | null>;
}
export declare function createSearch(options: { engines: SearchEngine[]; chat?: Chat | null; crawl?: (url: string, o?: { signal?: AbortSignal }) => Promise<CrawledPage | null>; fetch?: typeof fetch; maxSources?: number; readPages?: number }): Search;

export type SearchRoutes = (request: Request, options?: { user?: string | null; context?: string }) => Promise<Response | null>;
export declare function createSearchRoutes(options?: { search?: Search | null; prefix?: string; perMinute?: number }): SearchRoutes;
export declare function toWebRequest(req: unknown, base?: string): Promise<Request>;
export declare function sendWebResponse(res: unknown, response: Response): Promise<void>;

type Env = Record<string, string | undefined>;
export declare function enginesFromEnv(env?: Env, options?: { fetch?: typeof fetch }): SearchEngine[];
export declare function chatFromEnv(env?: Env, options?: { fetch?: typeof fetch }): Chat | null;
export declare function searchFromEnv(env?: Env, options?: { fetch?: typeof fetch; chat?: Chat | null }): Search | null;
export declare function searchRoutesFromEnv(env?: Env, options?: { prefix?: string; fetch?: typeof fetch; chat?: Chat | null; perMinute?: number }): SearchRoutes;
