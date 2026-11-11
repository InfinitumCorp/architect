# Safety scanning (optional tools)

Architect can check the projects it builds with four open-source scanners. None is installed or
shipped with Architect. Each check runs only if its tool is found; otherwise it is reported as
skipped, with the install command.

| Check id | Tool | Looks for | Network allowed |
|---|---|---|---|
| `osv-scanner` | google/osv-scanner | Dependencies with known vulnerabilities | api.osv.dev, osv-vulnerabilities.storage.googleapis.com, api.deps.dev |
| `git-secrets` | awslabs/git-secrets | Files matching prohibited secret patterns | none |
| `skillspector` | NVIDIA/SkillSpector | Risky patterns in agent skills, plugins and MCP configs (static analysis, `--no-llm`) | api.osv.dev |
| `garak` | NVIDIA/garak | Prompt injection and other LLM weaknesses in a model endpoint you name | `ARCHITECT_GARAK_HOSTS` only |

Scans run through the workspace sandbox (see [sandbox.md](sandbox.md)), so a scanner can only
write inside the project and reach the hosts listed above.

## Running

```bash
architect scan
```

```bash
architect scan path/to/project --only osv-scanner,git-secrets
```

The exit code is 1 when any check reports findings or fails. During a run the model can call the
`safety_scan` tool (read-only, `shell` permission) on its workspace.

## Installing the scanners

**osv-scanner**: download a release binary from https://github.com/google/osv-scanner/releases, or:

```bash
go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest
```

**git-secrets**: on macOS `brew install git-secrets`; on Linux clone
https://github.com/awslabs/git-secrets and run `make install`; on Windows run `install.ps1` from
that repository. Then register patterns, for example:

```bash
git secrets --register-aws --global
```

To add its pre-commit hook to a repository (a person runs this; the sandbox keeps `.git/hooks`
read-only for commands):

```bash
architect scan --install-hooks
```

**SkillSpector** (Python 3.12+):

```bash
uv tool install git+https://github.com/NVIDIA/skillspector.git
```

It runs only when the project contains `SKILL.md`, `.mcp.json`, `plugin.json`,
`marketplace.json`, or a `skills/`, `.claude/` or `.claude-plugin/` folder.

**garak**:

```bash
python -m pip install -U garak
```

garak probes a live model, so it runs only when you say which one:

| Variable | Meaning |
|---|---|
| `ARCHITECT_GARAK_ARGS` | Arguments for `python -m garak`, e.g. `--target_type openai --target_name <model> --probes promptinject` |
| `ARCHITECT_GARAK_HOSTS` | Comma-separated hosts garak may reach (the model endpoint) |
| `ARCHITECT_GARAK_PASS_ENV` | Comma-separated names of key variables garak needs. Commands normally don't see secret-looking variables. |

Keys stay in your environment or `.env`; never paste them into a chat or a plan.
