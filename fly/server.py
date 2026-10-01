"""ハエの脳を HTTP で叩けるようにする (標準ライブラリだけ)。

脳は 1 つで、状態はリクエストをまたいで続く。同時に来ても順番に進めるようロックで守る。
使い方: python fly/server.py   (FLY_PORT, FLY_DATA_DIR で変更)
"""

from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from brain import Brain  # noqa: E402

MIN_MS, MAX_MS = 10.0, 2000.0

brain: Brain | None = None
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n == 0:
            return {}
        data = json.loads(self.rfile.read(n).decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("body must be a JSON object")
        return data

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "neurons": brain.n, "synapses": brain.synapses, "device": brain.device.type})
        elif self.path == "/groups":
            self._send(
                200,
                {
                    "inputs": {k: {"n": g.n, "cell_types": g.cell_types} for k, g in brain.inputs.items()},
                    "outputs": {k: {"n": g.n, "cell_types": g.cell_types} for k, g in brain.outputs.items()},
                },
            )
        else:
            self._send(404, {"error": f"unknown path {self.path}"})

    def do_POST(self):
        try:
            body = self._body()
        except (ValueError, UnicodeDecodeError) as e:
            self._send(400, {"error": f"bad JSON: {e}"})
            return
        if self.path == "/reset":
            with lock:
                brain.reset()
            self._send(200, {"ok": True})
        elif self.path == "/step":
            stimuli = body.get("stimuli") or {}
            if not isinstance(stimuli, dict):
                self._send(400, {"error": "stimuli must be an object {channel: 0..1}"})
                return
            unknown = [k for k in stimuli if k not in brain.inputs]
            if unknown:
                self._send(400, {"error": f"unknown channel(s): {unknown}. known: {list(brain.inputs)}"})
                return
            try:
                stimuli = {k: float(v) for k, v in stimuli.items()}
                dur = float(body.get("duration_ms", 200))
            except (TypeError, ValueError):
                self._send(400, {"error": "stimulus values and duration_ms must be numbers"})
                return
            dur = min(max(dur, MIN_MS), MAX_MS)
            with lock:
                r = brain.run(stimuli, dur)
            r.pop("_counts", None)
            self._send(200, r)
        else:
            self._send(404, {"error": f"unknown path {self.path}"})

    def log_message(self, fmt, *args):
        # 既定は 1 リクエスト 1 行を stderr に出す。ボットが毎秒叩くとうるさいので黙らせる
        pass


def main():
    global brain
    port = int(os.environ.get("FLY_PORT", "8790"))
    brain = Brain()
    print(f"fly brain ready: {brain.n} neurons, {brain.synapses} synapses on {brain.device} (load {brain.load_s:.1f}s)")
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"listening on http://127.0.0.1:{port}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
