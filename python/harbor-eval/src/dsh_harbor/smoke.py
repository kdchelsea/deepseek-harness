"""Generate a disposable integration task; its reward is never a benchmark score."""

from pathlib import Path


MOCK_SERVER = r'''"""Local scripted Messages endpoint for the DSH integration smoke only."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Smoke request bodies and headers must not enter container logs.

    def do_GET(self):
        body = json.dumps({"data": [{"id": "deepseek-v4-flash"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        seen_tool = any(
            isinstance(m.get("content"), list) and any(b.get("type") == "tool_result" for b in m["content"])
            for m in request.get("messages", [])
        )
        if not seen_tool:
            tools = request.get("tools", [])
            tool = next(t for t in tools if t["name"].split("__")[-1] == "bash")
            command = "python3 -c 'import json; from pathlib import Path; values=json.loads(Path(\"/app/input.json\").read_text()); Path(\"/app/result.json\").write_text(json.dumps({\"sum\": sum(values)}))'"
            # Construct only the fields the native bash tool expects.
            arguments = {"command": command, "description": "Calculate sum from the input file", "workdir": "/app", "timeoutMs": 10000, "run_in_background": False}
            content = {"type": "tool_use", "id": "smoke-tool", "name": tool["name"], "input": arguments}
            stop = "tool_use"
        else:
            content = {"type": "text", "text": "Finished the integration task."}
            stop = "end_turn"
        events = [
            {"type": "message_start", "message": {"id": "smoke", "type": "message", "role": "assistant", "content": [], "model": request["model"], "usage": {"input_tokens": 10, "output_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": content},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": stop}, "usage": {"output_tokens": 10}},
            {"type": "message_stop"},
        ]
        body = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

HTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
'''


def create_task(destination: Path, keyless: bool) -> None:
    """Create a new Harbor task, refusing to overwrite any existing directory."""
    destination.mkdir(parents=True, exist_ok=False)
    files = {
        "instruction.md": "Read /app/input.json, which contains an array of integers. Calculate their sum and write /app/result.json as a JSON object with one key, sum, containing the numeric result. Use tools to create the file.\n",
        "task.toml": '''schema_version = "1.4"
[metadata]
category = "integration-smoke"
[agent]
timeout_sec = 180.0
[verifier]
timeout_sec = 30.0
environment_mode = "shared"
[environment]
build_timeout_sec = 600.0
''',
        "environment/Dockerfile": "FROM python:3.12-slim-bookworm\nWORKDIR /app\nCOPY input.json /app/input.json\n",
        "environment/input.json": "[12, 17, 13]\n",
        "solution/solve.sh": "#!/bin/bash\nset -eu\nprintf '%s\\n' '{\"sum\": 42}' > /app/result.json\n",
        "tests/test.sh": '''#!/bin/bash
set -eu
mkdir -p /logs/verifier
python3 - <<'PY'
import json
from pathlib import Path
try:
    passed = json.loads(Path('/app/result.json').read_text()) == {'sum': 42}
except (OSError, ValueError):
    passed = False
Path('/logs/verifier/reward.txt').write_text('1' if passed else '0')
PY
''',
    }
    if keyless:
        files["environment/mock.py"] = MOCK_SERVER
        files["environment/entrypoint.sh"] = '#!/bin/bash\nset -eu\npython3 /opt/dsh-smoke/mock.py &\nexec "$@"\n'
        files["environment/Dockerfile"] += 'COPY mock.py entrypoint.sh /opt/dsh-smoke/\nENTRYPOINT ["/bin/bash", "/opt/dsh-smoke/entrypoint.sh"]\n'
    for name, content in files.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
