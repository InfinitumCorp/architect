# Command sandbox and command policy

Every command the workspace instrument runs (`workspace_run`) goes through two layers:

1. **Command policy** (`src/sandbox/execpolicy.ts`). The command line is split into simple
   commands and each is matched against prefix rules. The strictest decision wins:
   - `allow`: runs like any routine write.
   - `approve`: treated as irreversible, so it pauses for a person (Autopilot needs
     `standing.irreversible` to skip that). Pushes, deploys, publishes, database pushes, PR merges
     and recursive deletes are here, along with anything the parser cannot follow: `$(...)`,
     backticks, `eval`, `bash -c '...'`.
   - `deny`: never runs, even with an approval. `sudo` and friends, disk formatting, power
     commands, and piping a download into an interpreter (`curl ... | sh`).
2. **OS sandbox** (`src/sandbox/runtime.ts`), backed by
   [`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime)
   (Apache-2.0). Commands can write only the run's workspace folder and the temp folder; `.env`,
   `.git/hooks` and `.git/config` stay read-only; credentials in the home folder (`~/.ssh`,
   `~/.aws`, `~/.config/gh`, `~/.npmrc`, `~/.wrangler` and others) cannot be read; network reaches
   package registries and code hosts only (npm, GitHub, PyPI, crates.io, the Go proxy).

Secret-looking environment variables (names containing KEY, TOKEN, SECRET, PASSWORD and similar)
are not passed to commands. To let one through, for example `NPM_TOKEN` for a private registry,
pass `passEnv: ["NPM_TOKEN"]` to `WorkspaceInstrument`.

## Modes

`ARCHITECT_SANDBOX` chooses how strict the sandbox is:

| Value | Behaviour |
|---|---|
| `auto` (default) | Use the sandbox where the machine supports it. If it cannot start, commands run unconfined and each result says so. On Windows `auto` does not start it (see below). |
| `required` | Use the sandbox or run nothing: commands fail if it cannot start. |
| `off` | No OS sandbox. The command policy still applies. |

Platform requirements (from the sandbox-runtime documentation):

- **macOS**: nothing to install (`sandbox-exec`).
- **Linux**: `bubblewrap` and `socat` (`apt install bubblewrap socat`).
- **Windows**: a one-time install by an administrator creates the `srt-sandbox` account and the
  firewall filters (`npx srt --help` lists the Windows install command). Because that install
  needs elevation, `auto` never starts it on its own; set `ARCHITECT_SANDBOX=required` once it is
  installed.

## Your own rules

Point `ARCHITECT_EXECPOLICY` at a JSON file to add rules. File rules are checked alongside the
built-in ones and the strictest decision wins, so a file can tighten the defaults but cannot turn
a built-in `deny` into `allow`.

```json
{
  "rules": [
    { "pattern": ["npm", "install"], "decision": "approve", "justification": "dependency changes need review" },
    { "pattern": ["docker", ["run", "build"]], "decision": "approve" }
  ],
  "defaultDecision": "allow",
  "opaqueDecision": "approve"
}
```

A pattern is matched against the start of a command's words. A token can be a list of
alternatives. Flag tokens (starting with `-` or `/`) may appear anywhere after the program name;
other tokens must be the next word that is not a flag. Leading `VAR=value` assignments and
wrappers such as `env`, `npx`, `timeout 30` are skipped before matching.

The rule design follows openai/codex `execpolicy` (Apache-2.0): prefix rules with decisions,
strictest wins. Only the idea was used; no code was copied.

## Where this does not apply

The Cloudflare Workers edition (`src/worker.ts`) has no workspace instrument and runs no shell
commands, so neither layer is loaded there.
