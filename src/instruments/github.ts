import { truncate } from "../policy.js";
import { lineDiff } from "./diff.js";
import type { Instrument, ToolContext, ToolOutput, ToolSpec } from "./types.js";

/**
 * Cloud coding on GitHub: the agent reads and searches a repository, commits its edits to its own
 * branch (architect/<run id>), shows the diff, and opens a pull request — which, like every
 * irreversible action, waits for a person's approval. Works in the Cloudflare Worker (fetch only).
 */
export interface GitHubOptions {
  /** A fine-grained token with contents and pull-request access to the allowed repositories. */
  token: string;
  /** owner/name repositories the agent may touch. Empty means every repository the token reaches. */
  repos?: string[];
  fetch?: typeof fetch;
  api?: string;
}

const RULE_FILES = ["ARCHITECT.md", "AGENTS.md", "CLAUDE.md", ".cursorrules", "GROK.md"];

const toB64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromB64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

const repoProp = { repo: { type: "string", description: "owner/name" } };

export class GitHubInstrument implements Instrument {
  name = "repo";
  description = "A GitHub repository, in the cloud. Read, search and edit files on the run's own branch, review the diff, and open a pull request.";
  private f: typeof fetch;
  private api: string;
  private branches = new Map<string, string>();

  constructor(private opts: GitHubOptions) {
    this.f = opts.fetch ?? ((...a) => fetch(...a));
    this.api = (opts.api ?? "https://api.github.com").replace(/\/$/, "");
  }

  tools: ToolSpec[] = [
    { name: "repo_list", description: "List a folder of the repository (default: the root) on the run's branch.", input_schema: { type: "object", properties: { ...repoProp, path: { type: "string" } }, required: ["repo"] }, permission: "workspace.read", risk: "read" },
    { name: "repo_read", description: "Read a text file from the repository on the run's branch.", input_schema: { type: "object", properties: { ...repoProp, path: { type: "string" } }, required: ["repo", "path"] }, permission: "workspace.read", risk: "read" },
    { name: "repo_search", description: "Search code in the repository's default branch (GitHub code search syntax). Returns matching paths.", input_schema: { type: "object", properties: { ...repoProp, query: { type: "string" } }, required: ["repo", "query"] }, permission: "workspace.read", risk: "read" },
    {
      name: "repo_edit",
      description: "Edit a file by exact string replacement (old_string must be unique) and commit it to the run's branch. Returns the diff.",
      input_schema: { type: "object", properties: { ...repoProp, path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, message: { type: "string" } }, required: ["repo", "path", "old_string", "new_string"] },
      permission: "workspace.write",
      risk: "write",
    },
    {
      name: "repo_write",
      description: "Create or replace a whole file and commit it to the run's branch.",
      input_schema: { type: "object", properties: { ...repoProp, path: { type: "string" }, content: { type: "string" }, message: { type: "string" } }, required: ["repo", "path", "content"] },
      permission: "workspace.write",
      risk: "write",
    },
    { name: "repo_diff", description: "Show every change on the run's branch compared with the default branch.", input_schema: { type: "object", properties: { ...repoProp }, required: ["repo"] }, permission: "workspace.read", risk: "read" },
    {
      name: "repo_open_pr",
      description: "Open a pull request from the run's branch into the default branch. A person approves this first.",
      input_schema: { type: "object", properties: { ...repoProp, title: { type: "string" }, body: { type: "string" } }, required: ["repo", "title"] },
      permission: "workspace.write",
      risk: "irreversible",
    },
  ];

  private async gh(path: string, init: RequestInit = {}): Promise<{ status: number; data: any }> {
    const res = await this.f(`${this.api}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.opts.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "architect-agent",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    return { status: res.status, data };
  }

  private repo(input: Record<string, unknown>): string {
    const r = String(input.repo ?? "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error(`repo must be owner/name, got "${r}"`);
    const allowed = this.opts.repos ?? [];
    if (allowed.length && !allowed.some((a) => a.toLowerCase() === r.toLowerCase())) throw new Error(`${r} is not one of the repositories this server may change`);
    return r;
  }

  private static path(p: unknown) {
    const s = String(p ?? "").replace(/^\/+/, "");
    if (s.split("/").some((part) => part === "..")) throw new Error("path may not contain ..");
    return s.split("/").map(encodeURIComponent).join("/");
  }

  private async defaultBranch(repo: string): Promise<string> {
    const r = await this.gh(`/repos/${repo}`);
    if (r.status !== 200) throw new Error(`cannot open ${repo}: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    return r.data.default_branch as string;
  }

  /** The run's branch, created from the default branch on first write. */
  private async branch(repo: string, runId: string, create: boolean): Promise<{ name: string; exists: boolean; base: string }> {
    const name = `architect/${runId}`;
    const base = await this.defaultBranch(repo);
    const key = `${repo}#${runId}`;
    if (this.branches.has(key)) return { name, exists: true, base };
    const found = await this.gh(`/repos/${repo}/git/ref/heads/${name}`);
    if (found.status === 200) {
      this.branches.set(key, name);
      return { name, exists: true, base };
    }
    if (!create) return { name, exists: false, base };
    const head = await this.gh(`/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
    if (head.status !== 200) throw new Error(`cannot read ${base}: HTTP ${head.status}`);
    const made = await this.gh(`/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${name}`, sha: head.data.object.sha }) });
    if (made.status !== 201) throw new Error(`cannot create branch ${name}: HTTP ${made.status} ${JSON.stringify(made.data).slice(0, 200)}`);
    this.branches.set(key, name);
    return { name, exists: true, base };
  }

  private async readFileAt(repo: string, path: string, ref: string): Promise<{ text: string; sha: string } | undefined> {
    const r = await this.gh(`/repos/${repo}/contents/${GitHubInstrument.path(path)}?ref=${encodeURIComponent(ref)}`);
    if (r.status === 404) return undefined;
    if (r.status !== 200) throw new Error(`cannot read ${path}: HTTP ${r.status}`);
    if (Array.isArray(r.data)) throw new Error(`${path} is a folder`);
    if (r.data.size > 1_000_000) throw new Error(`${path} is larger than 1 MB`);
    return { text: fromB64(r.data.content ?? ""), sha: r.data.sha };
  }

  private async commit(repo: string, runId: string, path: string, content: string, message: string, sha?: string) {
    const b = await this.branch(repo, runId, true);
    const r = await this.gh(`/repos/${repo}/contents/${GitHubInstrument.path(path)}`, {
      method: "PUT",
      body: JSON.stringify({ message, content: toB64(content), branch: b.name, ...(sha ? { sha } : {}) }),
    });
    if (r.status !== 200 && r.status !== 201) throw new Error(`commit failed for ${path}: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    return b.name;
  }

  /** Rule files from the default branch of the allowed repositories (only when exactly one is allowed). */
  async rules(): Promise<string> {
    const repos = this.opts.repos ?? [];
    if (repos.length !== 1) return "";
    const repo = repos[0]!;
    const base = await this.defaultBranch(repo).catch(() => "");
    if (!base) return "";
    const parts: string[] = [];
    for (const name of RULE_FILES) {
      const f = await this.readFileAt(repo, name, base).catch(() => undefined);
      if (f?.text.trim()) parts.push(`--- ${repo}/${name} ---\n${truncate(f.text.trim(), 8_000)}`);
    }
    return parts.join("\n\n");
  }

  async execute(tool: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    const repo = this.repo(input);
    const path = String(input.path ?? "").replace(/^\/+/, "");
    const b = await this.branch(repo, ctx.runId, false);
    const ref = b.exists ? b.name : b.base;
    switch (tool) {
      case "repo_list": {
        const r = await this.gh(`/repos/${repo}/contents/${GitHubInstrument.path(path)}?ref=${encodeURIComponent(ref)}`);
        if (r.status !== 200) return { text: `Cannot list ${path || "/"}: HTTP ${r.status}`, isError: true };
        const items = Array.isArray(r.data) ? r.data : [r.data];
        return { text: items.map((i: any) => (i.type === "dir" ? `${i.name}/` : i.name)).join("\n") || "(empty)" };
      }
      case "repo_read": {
        const f = await this.readFileAt(repo, path, ref);
        return f ? { text: truncate(f.text, 40_000) } : { text: `${path} does not exist on ${ref}.`, isError: true };
      }
      case "repo_search": {
        const q = encodeURIComponent(`${String(input.query)} repo:${repo}`);
        const r = await this.gh(`/search/code?q=${q}&per_page=50`);
        if (r.status !== 200) return { text: `Search failed: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`, isError: true };
        const paths = (r.data.items ?? []).map((i: any) => i.path as string);
        return { text: paths.length ? paths.join("\n") : "No matches (code search covers the default branch only)." };
      }
      case "repo_edit": {
        const f = await this.readFileAt(repo, path, ref);
        if (!f) return { text: `${path} does not exist; create it with repo_write.`, isError: true };
        const oldS = String(input.old_string);
        const newS = String(input.new_string);
        const count = oldS ? f.text.split(oldS).length - 1 : 0;
        if (count === 0) return { text: `old_string was not found in ${path}. Read the file and copy the text exactly.`, isError: true };
        if (count > 1) return { text: `old_string matches ${count} places in ${path}; add surrounding lines to make it unique.`, isError: true };
        const after = f.text.replace(oldS, () => newS);
        const branch = await this.commit(repo, ctx.runId, path, after, String(input.message ?? `Edit ${path}`), b.exists ? f.sha : undefined);
        const diff = lineDiff(f.text, after, path);
        ctx.addEvidence({ kind: "file", label: `edited ${repo}/${path}`, content: truncate(diff, 6_000) });
        return { text: `Committed to ${branch}.\n${truncate(diff, 4_000)}` };
      }
      case "repo_write": {
        const prev = await this.readFileAt(repo, path, ref);
        const content = String(input.content);
        const sha = b.exists ? prev?.sha : undefined;
        const branch = await this.commit(repo, ctx.runId, path, content, String(input.message ?? `${prev ? "Update" : "Add"} ${path}`), sha);
        ctx.addEvidence({ kind: "file", label: `${prev ? "rewrote" : "created"} ${repo}/${path}`, content: truncate(lineDiff(prev?.text ?? "", content, path), 6_000) });
        return { text: `Committed ${path} to ${branch}.` };
      }
      case "repo_diff": {
        if (!b.exists) return { text: "No changes yet: the run's branch does not exist." };
        const r = await this.gh(`/repos/${repo}/compare/${encodeURIComponent(b.base)}...${encodeURIComponent(b.name)}`);
        if (r.status !== 200) return { text: `Compare failed: HTTP ${r.status}`, isError: true };
        const files = (r.data.files ?? []) as Array<{ filename: string; status: string; patch?: string }>;
        return { text: truncate(files.map((x) => `${x.status} ${x.filename}\n${x.patch ?? ""}`).join("\n\n") || "No changes.", 30_000) };
      }
      case "repo_open_pr": {
        if (!b.exists) return { text: "Nothing to propose: make changes first.", isError: true };
        const r = await this.gh(`/repos/${repo}/pulls`, {
          method: "POST",
          body: JSON.stringify({ title: String(input.title).slice(0, 200), body: `${String(input.body ?? "")}\n\nOpened by :\\ARCHITECT\\ run ${ctx.runId}.`, head: b.name, base: b.base }),
        });
        if (r.status !== 201) return { text: `Could not open the pull request: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`, isError: true };
        ctx.addEvidence({ kind: "url", label: "pull request", content: r.data.html_url });
        return { text: `Opened ${r.data.html_url}` };
      }
      default:
        throw new Error(`unknown repo tool ${tool}`);
    }
  }
}
