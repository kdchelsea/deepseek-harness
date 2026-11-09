"""Command-line entry for preflight, Harbor execution, and binary-reward reports."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path


def positive_int(value: str) -> int:
    """Parse a nonzero task count for argparse."""
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return number


def doctor(key_env: str | None = None) -> list[str]:
    """Check local prerequisites without exposing credential values."""
    problems = []
    if not shutil.which("docker"):
        problems.append("Docker CLI is missing; install Docker Desktop or Docker Engine.")
    else:
        try:
            result = subprocess.run(["docker", "info"], capture_output=True, timeout=20)
            if result.returncode:
                problems.append("Docker daemon is unavailable; start Docker and run docker info.")
        except subprocess.TimeoutExpired:
            problems.append("Docker info timed out after 20 seconds.")
    if key_env and not os.environ.get(key_env):
        problems.append(f"{key_env} is empty; export the model API key before running.")
    return problems


def build_command(args: argparse.Namespace) -> list[str]:
    """Build Harbor argv using environment references rather than credential values."""
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", args.key_env):
        raise ValueError("key-env must be an environment variable name")
    argv = [sys.executable, "-m", "harbor.cli.main", "run", "-a", "dsh_harbor.agent:DshAgent",
            "-m", args.model, "-e", "docker", "-n", str(args.concurrency), "-k", str(args.attempts),
            "-r", "0", "-o", str(args.output.resolve()), "--job-name", args.name,
            "--ae", f"{args.key_env}=${{{args.key_env}}}"]
    if args.path:
        argv += ["-p", str(args.path.resolve())]
    else:
        if "@" not in args.dataset:
            raise ValueError("dataset must include a version, for example terminal-bench@2.0")
        argv += ["-d", args.dataset]
    if args.runtime_wheel:
        argv += ["--ak", f"runtime_wheel={args.runtime_wheel.resolve()}"]
    else:
        argv += ["--ak", f"runtime_version={args.runtime_version}"]
    if args.patch:
        argv += ["--ak", f"patch={args.patch.resolve()}"]
    if args.effort:
        argv += ["--ak", f"reasoning_effort={args.effort}"]
    if args.task:
        for task in args.task:
            argv += ["--task-name", task]
    if args.base_url:
        argv += ["--ae", f"DEEPSEEK_BASE_URL={args.base_url}"]
    return argv


def report(job: Path) -> dict[str, object]:
    """Report finished single-step binary trials; missing/errored results never pass."""
    from harbor.models.trial.result import TrialResult

    rows = []
    for file in sorted(job.glob("*/result.json")):
        result = TrialResult.model_validate_json(file.read_text(encoding="utf-8"))
        rewards = result.verifier_result.rewards if result.verifier_result else None
        reward = rewards.get("reward") if rewards else None
        if result.step_results or (reward is not None and reward not in (0, 1)):
            raise ValueError("This report supports single-step reward=0/1 tasks; use Harbor's results for other metrics")
        status = "error"
        if result.reward_valid and reward in (0, 1):
            status = "passed" if reward == 1 else "failed"
        elapsed = None
        timing = result.agent_execution
        if timing and timing.started_at and timing.finished_at:
            elapsed = (timing.finished_at - timing.started_at).total_seconds()
        rows.append({"task": result.task_name, "trial": result.trial_name, "status": status,
                     "reward": reward, "agent_seconds": elapsed,
                     "exception": result.exception_info.exception_type if result.exception_info else None})
    if not rows:
        raise ValueError(f"No completed trial results found under {job}")
    passed = sum(row["status"] == "passed" for row in rows)
    return {"completed_trials": len(rows), "passed": passed,
            "failed": sum(row["status"] == "failed" for row in rows),
            "errors": sum(row["status"] == "error" for row in rows),
            "passed_over_completed": passed / len(rows),
            "scope": "Completed trials only; errors remain in the denominator. Check Harbor job completion before publishing.",
            "trials": rows}


def parser() -> argparse.ArgumentParser:
    """Define the local evaluation CLI."""
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    smoke = commands.add_parser("smoke-task", help="create an integration task, not a capability benchmark")
    smoke.add_argument("output", type=Path)
    smoke.add_argument("--keyless", action="store_true", help="include a scripted local model endpoint")
    check = commands.add_parser("doctor", help="check Docker and optional credential availability")
    check.add_argument("--key-env")
    run = commands.add_parser("run", help="run DSH in disposable Docker task environments")
    tasks = run.add_mutually_exclusive_group(required=True)
    tasks.add_argument("--path", type=Path, help="local Harbor task or task collection")
    tasks.add_argument("--dataset", help="versioned Harbor dataset name")
    runtime = run.add_mutually_exclusive_group(required=True)
    runtime.add_argument("--runtime-version", help="exact published DSH runtime version")
    runtime.add_argument("--runtime-wheel", type=Path, help="local Linux runtime wheel for the container architecture")
    run.add_argument("--model", required=True, help="DSH provider/model, e.g. deepseek-official/deepseek-v4-flash")
    run.add_argument("--name", required=True, help="new Harbor job name")
    run.add_argument("--output", type=Path, default=Path(".artifacts/dsh-eval"))
    run.add_argument("--concurrency", type=positive_int, default=1)
    run.add_argument("--attempts", type=positive_int, default=1)
    run.add_argument("--task", action="append", help="task-name filter; repeatable")
    run.add_argument("--key-env", default="DEEPSEEK_API_KEY")
    run.add_argument("--base-url", help="DeepSeek API base URL, including /anthropic when required by the provider")
    run.add_argument("--patch", type=Path, help="custom DSH Cordis overlay, applied before model selection")
    run.add_argument("--effort")
    run.add_argument("--dry-run", action="store_true", help="print argv without Docker or model calls")
    summary = commands.add_parser("report", help="summarize completed binary-reward trials as JSON")
    summary.add_argument("job", type=Path)
    return root


def main() -> None:
    """Validate prerequisites and hand execution to Harbor's normal CLI."""
    args = parser().parse_args()
    try:
        if args.command == "smoke-task":
            from dsh_harbor.smoke import create_task
            create_task(args.output, args.keyless)
            print(f"Created integration task at {args.output}; this is not a benchmark score.")
            return
        if args.command == "report":
            print(json.dumps(report(args.job), ensure_ascii=False, indent=2))
            return
        if args.command == "doctor":
            problems = doctor(args.key_env)
            print("\n".join(problems) if problems else "Docker is ready; requested credential is present.")
            raise SystemExit(bool(problems))
        command = build_command(args)
        # Validate custom-agent configuration before allocating task environments.
        from dsh_harbor.agent import DshAgent
        DshAgent(logs_dir=args.output, model_name=args.model,
                 runtime_version=args.runtime_version,
                 runtime_wheel=str(args.runtime_wheel) if args.runtime_wheel else None,
                 patch=str(args.patch) if args.patch else None)
        if args.dry_run:
            print(shlex.join(command))
            return
        if (args.output / args.name).exists():
            raise ValueError("Job directory already exists; choose a new --name to preserve prior results")
        problems = doctor(args.key_env)
        if problems:
            raise ValueError("\n".join(problems))
        os.execv(sys.executable, command)
    except (OSError, ValueError) as error:
        print(f"dsh-eval: {error}", file=sys.stderr)
        raise SystemExit(2) from error


if __name__ == "__main__":
    main()
