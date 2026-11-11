import { describe, expect, it } from "vitest";
import { GitHubInstrument } from "../src/instruments/github.js";
import type { ToolContext } from "../src/instruments/types.js";

/** A tiny in-memory GitHub: one repo, branches as file maps. */
function fakeGitHub() {
  const branches = new Map<string, Map<string, string>>([["main", new Map([["src/a.ts", "const x = 1;\nexport default x;\n"], ["AGENTS.md", "Prefer const."]])]]);
  const calls: string[] = [];
  const b64 = (t: string) => Buffer.from(t).toString("base64");
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    let m: RegExpMatchArray | null;
    if (u.pathname === "/repos/acme/app") return ok(200, { default_branch: "main" });
    if ((m = u.pathname.match(/^\/repos\/acme\/app\/git\/ref\/heads\/(.+)$/))) {
      const name = decodeURIComponent(m[1]!);
      return branches.has(name) ? ok(200, { object: { sha: `sha-${name}` } }) : ok(404, {});
    }
    if (u.pathname === "/repos/acme/app/git/refs" && method === "POST") {
      branches.set(body.ref.replace("refs/heads/", ""), new Map(branches.get("main")));
      return ok(201, {});
    }
    if ((m = u.pathname.match(/^\/repos\/acme\/app\/contents\/(.+)$/))) {
      const path = decodeURIComponent(m[1]!);
      if (method === "PUT") {
        branches.get(body.branch)!.set(path, Buffer.from(body.content, "base64").toString());
        return ok(200, {});
      }
      const files = branches.get(u.searchParams.get("ref")!)!;
      return files.has(path) ? ok(200, { content: b64(files.get(path)!), sha: "s1", size: 10 }) : ok(404, {});
    }
    if (u.pathname.startsWith("/repos/acme/app/compare/")) return ok(200, { files: [{ filename: "src/a.ts", status: "modified", patch: "-const x = 1;\n+const x = 2;" }] });
    if (u.pathname === "/repos/acme/app/pulls") return ok(201, { html_url: "https://github.com/acme/app/pull/7", head: body.head });
    return ok(404, { message: "no route " + u.pathname });
  }) as unknown as typeof fetch;
  return { fetchImpl, branches, calls };
}

const ev: Array<{ label: string }> = [];
const ctx = { runId: "run_abc", stepId: "s1", runDir: "", putFile: async () => {}, addEvidence: (e: { label: string }) => (ev.push(e), e) } as unknown as ToolContext;

describe("GitHub cloud coding", () => {
  it("edits on its own branch, shows the diff and opens a pull request", async () => {
    const gh = fakeGitHub();
    const repo = new GitHubInstrument({ token: "t", repos: ["acme/app"], fetch: gh.fetchImpl });
    expect((await repo.execute("repo_read", { repo: "acme/app", path: "src/a.ts" }, ctx)).text).toContain("const x = 1;");
    const edit = await repo.execute("repo_edit", { repo: "acme/app", path: "src/a.ts", old_string: "const x = 1;", new_string: "const x = 2;" }, ctx);
    expect(edit.text).toContain("Committed to architect/run_abc");
    expect(gh.branches.get("architect/run_abc")!.get("src/a.ts")).toContain("const x = 2;");
    expect(gh.branches.get("main")!.get("src/a.ts")).toContain("const x = 1;");
    expect((await repo.execute("repo_diff", { repo: "acme/app" }, ctx)).text).toContain("+const x = 2;");
    expect((await repo.execute("repo_open_pr", { repo: "acme/app", title: "Bump x" }, ctx)).text).toBe("Opened https://github.com/acme/app/pull/7");
    expect(repo.tools.find((t) => t.name === "repo_open_pr")!.risk).toBe("irreversible");
    expect(await repo.rules()).toContain("Prefer const.");
  });

  it("refuses repositories outside the allow list and parent paths", async () => {
    const repo = new GitHubInstrument({ token: "t", repos: ["acme/app"], fetch: fakeGitHub().fetchImpl });
    await expect(repo.execute("repo_read", { repo: "evil/other", path: "x" }, ctx)).rejects.toThrow(/not one of the repositories/);
    await expect(repo.execute("repo_read", { repo: "acme/app", path: "../x" }, ctx)).rejects.toThrow(/\.\./);
  });
});
