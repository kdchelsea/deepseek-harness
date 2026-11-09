"""Report validation against Harbor's actual persisted trial schema."""

import json
from pathlib import Path

import pytest
from harbor.models.trial.result import TrialResult

from dsh_harbor.cli import report


def write_trial(root: Path, reward: float | None, error: str | None = None, **extra) -> None:
    trial = {
        "task_name": "sample", "trial_name": "sample-1", "trial_uri": "file:///unused",
        "task_id": {"path": "/unused"}, "task_checksum": "fixture",
        "config": {"task": {"path": "/unused"}, "agent": {"name": "dsh_harbor.agent:DshAgent"}},
        "agent_info": {"name": "dsh", "version": "fixture"},
        "verifier_result": {"rewards": {"reward": reward}} if reward is not None else None,
        **extra,
    }
    if error:
        trial["exception_info"] = {"exception_type": error, "exception_message": "fixture", "exception_traceback": "", "occurred_at": "2026-01-01T00:00:00Z"}
    parsed = TrialResult.model_validate(trial)
    directory = root / "trial"
    directory.mkdir()
    (directory / "result.json").write_text(parsed.model_dump_json())


@pytest.mark.parametrize("reward,error,status", [
    (1, None, "passed"), (0, None, "failed"),
    (1, "NonZeroAgentExitCodeError", "error"),
    (None, None, "error"), (0, "AgentTimeoutError", "failed"),
])
def test_report_uses_harbor_reward_validity(tmp_path, reward, error, status):
    write_trial(tmp_path, reward, error)
    summary = report(tmp_path)
    assert summary["trials"][0]["status"] == status
    assert summary["completed_trials"] == 1
    assert summary["passed_over_completed"] == (1 if status == "passed" else 0)


def test_report_rejects_nonbinary_rewards(tmp_path):
    write_trial(tmp_path, 0.5)
    with pytest.raises(ValueError, match="single-step"):
        report(tmp_path)


def test_report_does_not_publish_an_empty_job_as_zero_score(tmp_path):
    with pytest.raises(ValueError, match="No completed"):
        report(tmp_path)


def test_report_rejects_multistep_trials(tmp_path):
    write_trial(tmp_path, 1, step_results=[{"step_name": "one"}])
    with pytest.raises(ValueError, match="single-step"):
        report(tmp_path)
