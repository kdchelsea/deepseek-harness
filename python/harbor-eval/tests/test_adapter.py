"""Behavior checks for adapter completion, credential forwarding, and smoke scoring."""

import asyncio
import json
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import TaskConfig

from dsh_harbor.agent import DshAgent, inspect_stream
from dsh_harbor.cli import build_command, parser
from dsh_harbor.smoke import MOCK_SERVER, create_task


def event_stream(path: Path, reason: str = "completed") -> None:
    path.write_text("\n".join(json.dumps(event) for event in [
        {"type": "session", "sessionId": "smoke"},
        {"type": "tool_call", "name": "bash"},
        {"type": "final", "reason": {"kind": reason}},
    ]) + "\n")


def make_agent(tmp_path: Path, **kwargs) -> DshAgent:
    return DshAgent(logs_dir=tmp_path, model_name="deepseek-official/deepseek-v4-flash",
                    runtime_version="0.2.1rc2", **kwargs)


@pytest.mark.parametrize("reason,completed", [("completed", True), ("error", False), ("aborted", False)])
def test_run_completion_does_not_assign_reward_or_usage(tmp_path, reason, completed):
    path = tmp_path / "dsh.jsonl"
    event_stream(path, reason)
    assert inspect_stream(path)["stream_completed"] is completed
    context = AgentContext()
    make_agent(tmp_path).populate_context_post_run(context)
    assert context.n_input_tokens is None
    assert context.cost_usd is None
    assert context.metadata["dsh"]["tool_calls"] == 1


@pytest.mark.parametrize("text", ['{', '[]\n', '{"type":"final","reason":{"kind":"completed"}}\n{"type":"text"}\n'])
def test_invalid_log_is_visible_in_result_metadata(tmp_path, text):
    (tmp_path / "dsh.jsonl").write_text(text)
    context = AgentContext()
    make_agent(tmp_path).populate_context_post_run(context)
    assert context.metadata["dsh"]["stream_completed"] is False
    assert context.metadata["dsh"]["log_error"]


def test_missing_final_is_incomplete(tmp_path):
    path = tmp_path / "dsh.jsonl"
    path.write_text('{"type":"session","sessionId":"partial"}\n')
    assert inspect_stream(path)["stream_completed"] is False


@pytest.mark.parametrize("tail,completed", [
    ([], True),
    ([{"type": "status", "phase": "turn_start"}], False),
])
def test_published_stream_uses_only_the_latest_ended_turn(tmp_path, tail, completed):
    path = tmp_path / "dsh.jsonl"
    events = [{"type": "status", "phase": "turn_end", "reason": {"kind": "completed"}},
              *tail, {"type": "final", "text": "finished"}]
    path.write_text("\n".join(map(json.dumps, events)) + "\n")
    assert inspect_stream(path)["stream_completed"] is completed


def test_explicit_null_final_reason_cannot_inherit_completed_turn(tmp_path):
    path = tmp_path / "dsh.jsonl"
    path.write_text('{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\n{"type":"final","reason":null}\n')
    assert inspect_stream(path)["stream_completed"] is False


def test_missing_log_remains_visible(tmp_path):
    context = AgentContext()
    make_agent(tmp_path).populate_context_post_run(context)
    assert "log_error" in context.metadata["dsh"]


def test_runtime_source_must_be_explicit(tmp_path):
    with pytest.raises(ValueError, match="exactly one"):
        DshAgent(logs_dir=tmp_path, model_name="route/model")
    with pytest.raises(ValueError, match="exactly one"):
        make_agent(tmp_path, runtime_wheel="missing.whl")


@pytest.mark.parametrize("version", ["latest", ">=0.2", "0.2.1rc2;touch /tmp/invalid"])
def test_runtime_version_cannot_be_a_range_or_shell_expression(tmp_path, version):
    with pytest.raises(ValueError):
        DshAgent(logs_dir=tmp_path, model_name="route/model", runtime_version=version)


def test_argv_keeps_secret_as_environment_reference(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "secret-not-for-argv")
    args = parser().parse_args(["run", "--dataset", "terminal-bench@2.0", "--runtime-version", "0.2.1rc2",
                               "--model", "deepseek-official/model", "--name", "sample", "--attempts", "3"])
    command = build_command(args)
    assert "DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}" in command
    assert "secret-not-for-argv" not in " ".join(command)
    assert command[command.index("-k") + 1] == "3"
    assert command[command.index("-r") + 1] == "0"


@pytest.mark.parametrize("exit_code,reason,raises", [(0, "completed", False), (1, "completed", True), (0, "error", True)])
def test_run_preserves_process_failure_and_requires_completed_final(tmp_path, exit_code, reason, raises):
    agent = make_agent(tmp_path)
    agent.home = "/logs/agent/dsh-home"
    agent.route_path = "/logs/agent/route.yaml"
    agent.owner = "1000:1000"
    environment = AsyncMock(spec=BaseEnvironment)
    async def execute(command, **kwargs):
        return ExecResult(return_code=exit_code if "/dsh-venv/bin/dsh" in command else 0, stdout="", stderr="")
    environment.exec.side_effect = execute
    uploaded = []

    async def upload(source, target):
        uploaded.append((Path(source).read_text(), target))

    async def download(source, target):
        event_stream(Path(target), reason)

    environment.upload_file.side_effect = upload
    environment.download_file.side_effect = download
    context = AgentContext()
    task = "literal `command` and $(another command)\nsecond line"
    if raises:
        with pytest.raises(RuntimeError):
            asyncio.run(agent.run(task, environment, context))
    else:
        asyncio.run(agent.run(task, environment, context))
    assert context.is_empty()
    assert uploaded[0][0] == task
    first_exec = environment.exec.call_args_list[0].kwargs
    assert first_exec["user"] == "root"
    assert "chown 1000:1000" in first_exec["command"]
    assert "chmod 600" in first_exec["command"]
    call = environment.exec.call_args.kwargs
    assert task not in call["command"]
    assert call["cwd"] is None
    assert call["env"] == {"DSH_HOME": "/logs/agent/dsh-home", "DSH_PERMISSION_MODE": "danger-full-access"}
    assert "--profile headless" in call["command"]


def test_generated_task_has_valid_schema_and_refuses_overwrite(tmp_path):
    import tomllib
    task = tmp_path / "task"
    create_task(task, keyless=True)
    TaskConfig.model_validate(tomllib.loads((task / "task.toml").read_text()))
    compile(MOCK_SERVER, "mock.py", "exec")
    with pytest.raises(FileExistsError):
        create_task(task, keyless=False)
    assert "mock.py" in (task / "environment/Dockerfile").read_text()


def test_scripted_tool_command_computes_from_actual_input(tmp_path):
    # Extract the scripted endpoint's command with AST so the test exercises the
    # exact nested quoting that the real bash tool receives, without an HTTP server.
    import ast
    tree = ast.parse(MOCK_SERVER)
    command = next(node.value.value for node in ast.walk(tree)
                   if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "command" for t in node.targets))
    command = command.replace("/app/", str(tmp_path) + "/").replace("python3", __import__("sys").executable, 1)
    (tmp_path / "input.json").write_text("[4, 6, 8]")
    result = subprocess.run(["bash", "-c", command], capture_output=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert json.loads((tmp_path / "result.json").read_text()) == {"sum": 18}
