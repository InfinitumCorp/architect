/** Browser/Worker-safe client. Never accepts CID/org claims as authentication. */
export interface RepositoryInfo { id: string; name: string; visibility: "private"; branches: Record<string, string | null>; tags: Record<string, string> }
export interface ArtifactCommit { id: string; parent: string | null; tree: Record<string, string>; author: string; message: string; at: string }
export type LabyrinthCommand =
  | { action: "list" }
  | { action: "create"; name: string }
  | { action: "save"; repo: string; path: string; content: string; expectedHead: string | null; message?: string; branch?: string }
  | { action: "load"; repo: string; commit: string; path: string }
  | { action: "history"; repo: string; branch?: string; limit?: number }
  | { action: "diff"; repo: string; from: string | null; to: string }
  | { action: "provision" }
  | { action: "token" }
  | { action: "consent"; scopes: ("repo:read" | "repo:write" | "repo:admin")[] };
export interface LabyrinthClientOptions {
  endpoint: string;
  /** Return a real opaque CID session token; never a product API key or an unverified CID. */
  token?: () => string | undefined | Promise<string | undefined>;
  fetch?: typeof fetch;
}
export function secureLabyrinthEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Labyrinth requires HTTPS (loopback HTTP only for development)");
  return url.href;
}
export function createLabyrinthClient(product: string, options: LabyrinthClientOptions) {
  const endpoint = secureLabyrinthEndpoint(options.endpoint);
  const send = async <T>(command: LabyrinthCommand): Promise<T> => {
    const token = await options.token?.();
    const headers: Record<string, string> = { "content-type": "application/json", "x-labyrinth": "1" };
    if (token) {
      if (!/^[^\s]{1,512}$/.test(token)) throw new Error("Invalid CID session token");
      headers.authorization = `Bearer ${token}`;
    }
    const response = await (options.fetch ?? fetch)(endpoint, { method: "POST", headers, body: JSON.stringify({ ...command, product }), credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Labyrinth request denied (${response.status})`);
    return await response.json() as T;
  };
  return {
    product,
    repositories: () => send<RepositoryInfo[]>({ action: "list" }),
    createRepository: (name: string) => send<RepositoryInfo>({ action: "create", name }),
    save: (repo: string, path: string, content: string, expectedHead: string | null, message?: string, branch?: string) => send<ArtifactCommit>({ action: "save", repo, path, content, expectedHead, message, branch }),
    load: async (repo: string, commit: string, path: string) => (await send<{ content: string }>({ action: "load", repo, commit, path })).content,
    history: (repo: string, branch?: string, limit?: number) => send<ArtifactCommit[]>({ action: "history", repo, branch, limit }),
    diff: (repo: string, from: string | null, to: string) => send<{ path: string; before: string | null; after: string | null; kind: string }[]>({ action: "diff", repo, from, to }),
    /** User-invoked consent only; requires direct CID login, not a repository token. */
    consent: (scopes: ("repo:read" | "repo:write" | "repo:admin")[]) => send<unknown>({ action: "consent", scopes }),
    /** Same-origin CID cookie only; keep the returned repository-only bearer in memory. */
    sessionToken: () => send<{ token: string; expiresAt: string }>({ action: "token" }),
    provision: () => send<{ id: string; name: string }>({ action: "provision" }),
  };
}
