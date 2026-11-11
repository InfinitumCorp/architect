# OpenClaw: Architect as your assistant's coding agent

[OpenClaw](https://docs.openclaw.ai) is an open-source personal AI assistant that you reach over
Telegram, WhatsApp, Discord, iMessage and other chat channels. With this integration, coding
requests you send it ("fix the failing test in the shop repo", "add a dark mode toggle") go to
:\ARCHITECT\™. Architect plans the work, edits and runs the code, checks it with the project's
tests, and OpenClaw sends you the verified result in the same chat.

This page covers OpenClaw → Architect. For the other direction, where people inside Architect
type `@scalvs` to ask the SCALVS agent running on OpenClaw, see `src/openclaw/README.md` (PR #33).

## Set up

```bash
# 1. Run Architect on the project you want worked on (keep it running).
architect serve --workspace ~/code/shop

# 2. Stop the OpenClaw Gateway (openclaw mcp add needs it stopped), then:
architect openclaw

# 3. Start the Gateway again, and check:
openclaw skills check
openclaw mcp doctor architect --probe
```

`architect openclaw` installs two things:

| What | Where | Does |
|---|---|---|
| The `architect` skill | `~/.openclaw/skills/architect/SKILL.md` (or `<workspace>/skills/…` with `-w <openclaw workspace>`) | Tells the assistant when to delegate (bugs, features, tests, refactors, code review, explanations) and how to report back |
| The `architect` MCP server | OpenClaw's MCP registry (`mcp.servers.architect`), added with `openclaw mcp add` | Runs `architect mcp`, which offers `architect_run`, `architect_get_run`, `architect_list_runs`, `architect_pending_approvals`, `architect_recover` and `architect_cancel` |

If the `openclaw` CLI isn't on your PATH, or the Gateway is still running, the skill is installed
anyway and the exact `openclaw mcp add …` command is printed for you to run.

### Options

- `--server <url>` is the Architect server that `architect mcp` talks to. The default is
  `ARCHITECT_URL`, or `http://localhost:7337`. To use the hosted Architect, pass
  `--server https://rchtch.app`.
- If `ARCHITECT_API_TOKEN` is set, it is passed into the server definition so that `architect mcp`
  can authenticate. It is never printed: the printed command shows a placeholder instead.
- `-w <dir>` installs the skill into one OpenClaw workspace instead of the shared folder.

## Using it

From any OpenClaw channel:

- "Fix the failing test in the shop repo": OpenClaw calls `architect_run` and waits up to 10 minutes.
  It then replies with whether the fix was verified, what changed, the cost and the run id.
- "Now add a test for the empty cart" continues the same task (`follow_up` with the earlier run id).
- "What would you change to add dark mode?" plans only and changes nothing (`autonomy: rehearsal`).
- "What has Architect been doing?" lists recent runs.

## Safety

- **Approvals stay with people.** In the default `accompaniment` mode, risky actions (pushing,
  deploying, deleting, spending) wait for a person in the Architect app or CLI. The MCP server has
  no approve tool, and the skill tells the assistant never to try. So a chat message, including one
  someone else sends to your assistant, can't wave through Architect's risky actions.
- Only Architect's tools are added to OpenClaw: no new shell access. Architect still runs code
  inside its own workspace, under its sandbox and command policy (see `docs/sandbox.md`).
- Treat third-party OpenClaw skills as untrusted code. This one is plain instructions, with no
  scripts, and you can read it at `src/openclaw-skill.ts`.
