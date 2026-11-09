# Code-writing evals

`architect eval` measures how well a model writes code. It uses the task format from
openai/human-eval and reports pass@k the way openai/simple-evals does (both MIT). Architect's
harness was written from scratch; no code or data was copied.

## Safety first

Model-written code is untrusted, so it only runs inside the OS sandbox from
[sandbox.md](sandbox.md):

- no network at all;
- writes only to a fresh temporary folder per program, which is deleted afterwards;
- secret-looking environment variables are removed;
- Python runs with `-I` (isolated mode: no user site-packages, no current-folder imports);
- each program has a time limit (10 s by default), and the whole process tree is killed when it
  runs out.

If no isolating sandbox is available (for example Windows without the sandbox installed, or
`ARCHITECT_SANDBOX=off`), the harness refuses to run anything. `architect eval` always asks for
the sandbox, whatever `ARCHITECT_SANDBOX` says.

## Running

```bash
architect eval evals/sample-tasks.jsonl
```

```bash
architect eval tasks.jsonl --samples 10 --json
```

To score completions produced elsewhere (one `{"task_id", "completion"}` per line), without
calling a model:

```bash
architect eval tasks.jsonl --completions completions.jsonl
```

The model comes from the usual settings (`ARCHITECT_MODEL`, the router, or `architect.models.json`).
Set `ARCHITECT_EVAL_PYTHON` to choose the Python interpreter.

## Task format

One JSON object per line:

| Field | Meaning |
|---|---|
| `task_id` | Unique id |
| `prompt` | Python code to complete, usually a signature and docstring |
| `test` | Python defining `check(candidate)`, which asserts on the function |
| `entry_point` | Name of the function under test |

The program that runs is `prompt + completion + test + check(entry_point)`. It passes when it
exits with 0.

## Datasets

Architect ships only `evals/sample-tasks.jsonl`, three small tasks written for this repository.
It does not ship third-party datasets. In particular the openai/evals registry data is CC-BY-SA
or GFDL and is not included. To run the original HumanEval set, download it yourself from
openai/human-eval and pass the unzipped `.jsonl` file.

## Report

pass@k is the unbiased estimate `1 - C(n-c, k) / C(n, k)` for n samples with c correct,
averaged over tasks. Values of k larger than `--samples` are left out. The Markdown report
lists each metric, then every task that had a failing sample with the last error line.
