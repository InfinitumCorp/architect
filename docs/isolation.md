# Isolated runs

By default every run shares one workspace folder (`.architect/workspace`, or `--workspace`). With
per-run isolation each run gets a folder of its own, handed out by a supervisor
(`src/supervisor.ts`):

```
<workspace>/
  runs/<runId>/      the run's working folder: the only place its commands may write
  leases/<runId>.json  the supervisor's record (outside every run folder)
```

Turn it on with environment variables (or pass a `RunSupervisor` to `createArchitect`):

| Variable | Meaning |
|---|---|
| `ARCHITECT_ISOLATION=per-run` | One folder per run. |
| `ARCHITECT_MAX_CONCURRENT_RUNS=4` | Runs that may hold a folder at once; further runs wait for a slot when they first touch the workspace. |
| `ARCHITECT_WORKSPACE_SEED=<dir>` | Copy this folder into each new run folder (`node_modules` and `.git` skipped). |
| `ARCHITECT_WORKSPACE_SEED=git:<repo>[#ref]` | Make each run folder a detached `git worktree` of a local repository. |
| `ARCHITECT_RETAIN=on-failure` | Keep folders of failed and handed-off runs for a person (default). `always` keeps every folder, `never` removes them all. |

How a run's folder behaves:

- It is created and seeded the first time the run uses the workspace.
- `architect recover <runId>` gets the same folder back, files intact.
- When the run stops performing, the supervisor keeps or removes the folder by the retain policy.
  A handed-off run's HANDOFF.md lists the folder under Artifacts.
- The OS sandbox (see [sandbox.md](sandbox.md)) makes the run folder the only writable place, so
  one run's commands cannot change another run's files.
- On startup `RunSupervisor.reclaimStale()` drops leases left by a process that is no longer
  running; their folders are kept.

`RunSupervisor` also accepts operator hooks (`hooks.afterCreate`, `hooks.beforeRemove`): shell
commands from your configuration, run in the run folder. They never come from a model.

## Design references

- openai/symphony (Apache-2.0): a workspace manager maps each unit of work to a deterministic
  folder under one root, runs lifecycle hooks, keeps the folder across retries and cleans it up
  when the work is done, with bounded concurrency.
- awslabs/cli-agent-orchestrator (Apache-2.0): a supervisor owns the sessions of the agents it
  starts and reclaims what a crashed one left behind.

Only the designs were used. No code was copied from either project.
