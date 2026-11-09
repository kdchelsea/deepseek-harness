# Evaluate DSH with Harbor

English | [中文](README.zh.md)

## Summary

Run DSH's complete headless agent inside a disposable Docker task environment, then let Harbor's independent verifier grade the resulting files or environment state. This integration pins Harbor 0.25.0 and supports local tasks and versioned Terminal-Bench datasets. It does not replace DSH's model loop or tools.

## Table of Contents

- [Install](#install)
- [Check the integration](#check-the-integration)
- [Run a benchmark](#run-a-benchmark)
- [Read results](#read-results)
- [Configuration and limits](#configuration-and-limits)
- [Maintain the adapter](#maintain-the-adapter)

<a id="install"></a>

## Install

Use Python 3.12 or newer, uv, and a running Docker Engine or Docker Desktop. Run commands from the repository root. Keep the Python environment outside the source directory:

```sh
export UV_PROJECT_ENVIRONMENT="$PWD/.cache/dsh-harbor-venv"
uv sync --locked --project python/harbor-eval --group test
uv run --project python/harbor-eval dsh-eval doctor
```

Task images must provide bash, apt-get, root access during installation, and a distribution with Python 3.10 or newer and glibc 2.28 or newer. The generated smoke task uses Debian Bookworm. Installation needs network access to OS repositories and PyPI. Model execution additionally needs its provider endpoint.

<a id="check-the-integration"></a>

## Check the integration

Generate a new local task. Its scripted model tells the real DSH runtime to execute a tool that reads numbers and writes their sum. The verifier checks the file independently. This checks integration, not model intelligence:

```sh
uv run --project python/harbor-eval dsh-eval smoke-task .artifacts/dsh-eval/smoke --keyless
DEEPSEEK_API_KEY=dsh-keyless-smoke uv run --project python/harbor-eval dsh-eval run \
  --path .artifacts/dsh-eval/smoke \
  --runtime-version 0.2.1rc2 \
  --model deepseek-official/deepseek-v4-flash \
  --base-url http://127.0.0.1:8765/anthropic \
  --name smoke-dsh
uv run --project python/harbor-eval dsh-eval report .artifacts/dsh-eval/smoke-dsh
```

The credential above is a dummy value used only by the task-local mock endpoint. The expected reward is 1. Verify the grader's positive and negative controls too:

```sh
uv run --project python/harbor-eval harbor run -p .artifacts/dsh-eval/smoke -a oracle -e docker -n 1 -k 1 -r 0 -o .artifacts/dsh-eval --job-name smoke-oracle
uv run --project python/harbor-eval harbor run -p .artifacts/dsh-eval/smoke -a nop -e docker -n 1 -k 1 -r 0 -o .artifacts/dsh-eval --job-name smoke-nop
```

Oracle must receive 1; nop must receive 0. A zero process exit from Harbor does not establish that trials passed: inspect exceptions and verifier rewards. Existing task directories and DSH job names are rejected; use a fresh name when rerunning to retain previous evidence.

<a id="run-a-benchmark"></a>

## Run a benchmark

Export a real `DEEPSEEK_API_KEY` in the launching shell. The wrapper checks presence without displaying its value and passes an environment reference to Harbor. Start with a selected task and one attempt; increase attempts and concurrency after inspecting failures. This command previews the invocation without allocating containers or calling a model:

```sh
uv run --project python/harbor-eval dsh-eval run \
  --dataset terminal-bench@2.0 \
  --runtime-version 0.2.1rc2 \
  --model deepseek-official/deepseek-v4-flash \
  --name terminal-bench-baseline \
  --attempts 3 --concurrency 1 \
  --dry-run
```

Remove `--dry-run` to execute. Dataset availability, model access, and live model quality require a real evaluation; the keyless integration check does not establish a Terminal-Bench score. Use repeatable `--task NAME` filters for a small initial selection. Always retain the dataset version, task selection, attempts, model, reasoning effort, and DSH configuration with the report.

`--runtime-version` evaluates that published release, not the current checkout. To evaluate local DSH changes, build a Linux runtime wheel on the matching Linux architecture using the [Python build instructions](../development.md), then replace the version option with `--runtime-wheel /absolute/path/to/the-linux-runtime.whl`. The adapter uploads the wheel and records its SHA-256. Host macOS wheels cannot run inside Linux task containers.

<a id="read-results"></a>

## Read results

Each job directory contains Harbor's aggregate result and per-trial results. The `dsh-eval report JOB_DIRECTORY` command emits JSON with passes, verifier failures, execution errors, elapsed agent time, and individual trial outcomes. It supports single-step tasks whose `reward` is 0 or 1, respects Harbor's reward-validity policy, and keeps errors in the completed-trial denominator. It excludes unfinished trials; confirm the Harbor job has finished before publishing a score. Harbor may accept a verifier reward after an agent timeout; the exception remains visible in the row.

Each trial's `agent/` directory retains `dsh.jsonl`, `dsh.stderr.log`, `dsh-manifest.json`, the effective route overlay, the original task, and a separate `dsh-home/`. `stream_completed` describes the terminal JSON event only; process failure and verifier reward are separate facts. Missing or malformed logs produce explicit metadata diagnostics. Token and cost fields remain unknown because the headless JSON projection does not contain complete usage, including delegated agents.

To compare harness versions, hold the model, effort, task version, environment, and execution budgets fixed. Three attempts measure variation; this report's pass fraction is not pass@3. Do not label the generated smoke reward as a capability benchmark result.

<a id="configuration-and-limits"></a>

## Configuration and limits

`dsh-eval run --help` lists the wrapper options. The Harbor agent import path is `dsh_harbor.agent:DshAgent`; direct Harbor users can pass `runtime_version` or `runtime_wheel`, `patch`, `reasoning_effort`, and `permission_mode` through `--ak`.

- Model names use DSH's `provider/model` syntax. Harbor's LiteLLM warning for an unknown DSH provider does not change the route; DSH receives the explicit configuration.
- `--patch` supplies a self-contained Cordis overlay for additional provider settings. The generated model route and approval policy apply last. Do not place literal credentials in overlays; copied overlays and session logs are retained as artifacts.
- `--key-env` selects the credential environment name; `--base-url` sets `DEEPSEEK_BASE_URL`. Other providers need an appropriate DSH overlay. The wrapper does not translate arbitrary providers into DeepSeek configuration.
- The adapter preserves the task's working directory and execution user. Installation runs as container root. DSH uses `danger-full-access` inside the disposable container and `approval=never`; the host checkout and user DSH home are not mounted by this adapter. Direct Harbor users can select `permission_mode=workspace-write` to measure that policy instead.
- Harbor owns task timeouts, container teardown, and verifier execution. The wrapper disables orchestration retries so failed attempts are not silently replaced. Installation failure stops execution; partial logs remain available where Harbor can retrieve them.
- Resume, ATIF trajectory conversion, GUI evaluation, and complete token/cost accounting are not implemented. The supplied checks cover the installed release route; a locally built wheel needs its own smoke run.

<a id="maintain-the-adapter"></a>

## Maintain the adapter

Run the focused checks after changing the adapter:

```sh
uv run --project python/harbor-eval python -m pytest python/harbor-eval/tests -q
```

Tests cover malformed or missing logs, failed processes with completed-looking streams, literal task forwarding, credential references, private upload ownership, task generation, and report classification using Harbor's persisted schema. Rerun the container smoke and oracle/nop controls for execution changes. See [Harbor](https://github.com/harbor-framework/harbor/tree/v0.25.0) and [DSH headless](../../packages/bundle/headless/README.md) for the execution interfaces.
