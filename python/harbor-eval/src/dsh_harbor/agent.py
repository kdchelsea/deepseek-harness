"""Run the complete DSH runtime inside Harbor's disposable Linux environment."""

from __future__ import annotations

import hashlib
import json
import shlex
import tempfile
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from packaging.version import Version


def inspect_stream(path: Path) -> dict[str, object]:
    """Describe run completion without assigning a task reward or invented usage."""
    final = None
    session_id = None
    tool_calls = 0
    errors = 0
    last_turn_reason = None
    with path.open(encoding="utf-8") as stream:
        for number, line in enumerate(stream, 1):
            event = json.loads(line)
            if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                raise ValueError(f"Invalid DSH event on line {number}")
            if final is not None:
                raise ValueError("DSH emitted an event after its terminal final event")
            if event["type"] == "session":
                session_id = event.get("sessionId")
            elif event["type"] == "tool_call":
                tool_calls += 1
            elif event["type"] == "error":
                errors += 1
            elif event["type"] == "status":
                if event.get("phase") == "turn_start":
                    last_turn_reason = None
                elif event.get("phase") == "turn_end":
                    last_turn_reason = event.get("reason")
            elif event["type"] == "final":
                final = event
    # Published 0.2.1rc2 reports the reason on status/turn_end; newer runtimes
    # put it on final too. An explicit null on final must remain incomplete.
    reason = final.get("reason", last_turn_reason) if final else None
    return {
        "session_id": session_id,
        "final_reason": reason,
        "stream_completed": isinstance(reason, dict) and reason.get("kind") == "completed" and errors == 0,
        "tool_calls": tool_calls,
        "error_events": errors,
        "usage_available": False,
    }


class DshAgent(BaseInstalledAgent):
    """Install a pinned wheel and run headless; Harbor owns timeouts and scoring.

    Task environments must provide bash, apt-get, root installation access,
    Python >= 3.10, and glibc >= 2.28. The task's default user and working directory are preserved.
    runtime_version selects PyPI; runtime_wheel uploads a local Linux wheel.
    Exactly one is required. Unknown CLI kwargs belong to Harbor's base class.
    """

    def __init__(
        self,
        logs_dir: Path,
        runtime_version: str | None = None,
        runtime_wheel: str | None = None,
        reasoning_effort: str | None = None,
        patch: str | None = None,
        permission_mode: str = "danger-full-access",
        **kwargs: Any,  # Harbor passes extensible agent options through this interface.
    ) -> None:
        if bool(runtime_version) == bool(runtime_wheel):
            raise ValueError("Specify exactly one of runtime_version or runtime_wheel")
        if runtime_version:
            if str(Version(runtime_version)) != runtime_version:
                raise ValueError("runtime_version must be an exact canonical PEP 440 version")
        self.runtime_version = runtime_version
        self.runtime_wheel = Path(runtime_wheel).resolve() if runtime_wheel else None
        if self.runtime_wheel and (
            not self.runtime_wheel.is_file()
            or not self.runtime_wheel.name.startswith("deepseek_harness_runtime_bin-")
            or not self.runtime_wheel.name.endswith(".whl")
            or "manylinux" not in self.runtime_wheel.name
        ):
            raise ValueError("runtime_wheel must name an existing Linux DSH runtime wheel")
        self.patch = Path(patch).resolve() if patch else None
        if self.patch and not self.patch.is_file():
            raise ValueError("patch must name an existing Cordis overlay")
        if permission_mode not in {"workspace-write", "danger-full-access"}:
            raise ValueError("permission_mode must be workspace-write or danger-full-access")
        self.permission_mode = permission_mode
        self.reasoning_effort = reasoning_effort
        super().__init__(logs_dir=logs_dir, **kwargs)
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("model must be a DSH provider/model route")
        self.provider, self.model = self.model_name.split("/", 1)
        if not self.provider or not self.model:
            raise ValueError("model must contain both a DSH provider and model")

    @staticmethod
    def name() -> str:
        """Return the name shown in Harbor results."""
        return "dsh"

    def get_version_command(self) -> str:
        """Read the installed distribution version without booting a profile."""
        return "/installed-agent/dsh-venv/bin/python -c 'from importlib.metadata import version; print(version(\"deepseek-harness-runtime-bin\"))'"

    async def _upload_text(self, environment: BaseEnvironment, text: str, target: str) -> None:
        with tempfile.TemporaryDirectory(prefix="dsh-harbor-") as directory:
            source = Path(directory) / "input"
            source.write_text(text, encoding="utf-8")
            await environment.upload_file(source, target)
        await self.exec_as_root(environment, f"chown {self.owner} {shlex.quote(target)} && chmod 600 {shlex.quote(target)}")

    async def install(self, environment: BaseEnvironment) -> None:
        """Install the runtime and write task-local configuration, failing on errors."""
        await self.exec_as_root(
            environment,
            "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 python3-venv ca-certificates && python3 -m venv /installed-agent/dsh-venv",
        )
        identity = await self.exec_as_agent(environment, "id -u; id -g")
        uid, gid = (identity.stdout or "").split()
        if not uid.isdecimal() or not gid.isdecimal():
            raise RuntimeError("Cannot determine the task execution user's numeric uid/gid")
        self.owner = f"{uid}:{gid}"
        await self.exec_as_root(environment, "/installed-agent/dsh-venv/bin/python -c 'import sys; assert sys.version_info >= (3, 10), \"DSH requires Python >=3.10\"'")
        source = f"deepseek-harness-runtime-bin=={self.runtime_version}"
        digest = None
        if self.runtime_wheel:
            target = f"/installed-agent/{self.runtime_wheel.name}"
            await environment.upload_file(self.runtime_wheel, target)
            source = target
            with self.runtime_wheel.open("rb") as wheel:
                digest = hashlib.file_digest(wheel, "sha256").hexdigest()
        await self.exec_as_root(
            environment,
            f"/installed-agent/dsh-venv/bin/pip install --disable-pip-version-check --no-deps {shlex.quote(source)}",
        )
        version = await self.exec_as_agent(environment, self.get_version_command())
        self._version = (version.stdout or "").strip()
        if self.runtime_version and self._version != self.runtime_version:
            raise RuntimeError("Installed DSH version differs from the requested version")
        # The default task user owns its home and logs; no host DSH state is copied.
        self.home = str(self.environment_logs_dir / "dsh-home")
        await self.exec_as_agent(environment, f"mkdir -p {shlex.quote(self.home)}")
        config: dict[str, str] = {"provider": self.provider, "model": self.model}
        if self.reasoning_effort:
            config["reasoningEffort"] = self.reasoning_effort
        self.route_path = str(self.environment_logs_dir / "route.yaml")
        await self._upload_text(environment, json.dumps([
            {"id": "agent-default-model", "config": config},
            {"id": "approval", "config": {"policy": "never"}},
        ]), self.route_path)
        if self.patch:
            await self._upload_text(environment, self.patch.read_text(encoding="utf-8"), str(self.environment_logs_dir / "custom.yaml"))
        manifest = {
            "runtime_version": self._version,
            "runtime_wheel_sha256": digest,
            "model": self.model_name,
            "reasoning_effort": self.reasoning_effort,
            "permission_mode": self.permission_mode,
            "custom_patch_sha256": hashlib.sha256(self.patch.read_bytes()).hexdigest() if self.patch else None,
        }
        await self._upload_text(environment, json.dumps(manifest, indent=2) + "\n", str(self.environment_logs_dir / "dsh-manifest.json"))

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        """Submit the task unchanged; only an external verifier determines success."""
        prompt = str(self.environment_logs_dir / "instruction.txt")
        await self._upload_text(environment, instruction, prompt)
        argv = ["/installed-agent/dsh-venv/bin/dsh", "--profile", "headless"]
        if self.patch:
            argv += ["--patch", str(self.environment_logs_dir / "custom.yaml")]
        argv += ["--patch", self.route_path, "--json", "-"]
        stdout = shlex.quote(str(self.environment_logs_dir / "dsh.jsonl"))
        stderr = shlex.quote(str(self.environment_logs_dir / "dsh.stderr.log"))
        await self.exec_as_agent(
            environment,
            f"{shlex.join(argv)} < {shlex.quote(prompt)} > {stdout} 2> {stderr}",
            env={"DSH_HOME": self.home, "DSH_PERMISSION_MODE": self.permission_mode},
        )
        with tempfile.TemporaryDirectory(prefix="dsh-harbor-result-") as directory:
            stream = Path(directory) / "dsh.jsonl"
            await environment.download_file(str(self.environment_logs_dir / "dsh.jsonl"), stream)
            if not inspect_stream(stream)["stream_completed"]:
                raise RuntimeError("DSH exited zero without a completed final event; inspect dsh.jsonl")
        # Keep context empty: Harbor calls populate_context_post_run only after
        # downloading the logs, and only if no context fields have been filled.

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Retain completion diagnostics even when the process failed or timed out."""
        try:
            metadata = inspect_stream(self.logs_dir / "dsh.jsonl")
        except (OSError, UnicodeError, ValueError) as error:
            metadata = {"stream_completed": False, "log_error": str(error), "usage_available": False}
        context.metadata = {"dsh": metadata}
