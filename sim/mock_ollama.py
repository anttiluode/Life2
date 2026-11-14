"""A stand-in for Ollama, for testing the page without a real model.

    python sim/mock_ollama.py            # listens on 11434 like Ollama
    python sim/mock_ollama.py 11434 hang # never answers /api/chat (tests the page's timeout)

It answers /api/chat with a narration stitched from the facts it was sent. Every
fifth answer deliberately names a stranger ("Bartholomew" is not in any fact sheet,
but "Agnes" is a known name pool word) so the page's guard has something to catch.
"""
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

N = [0]
HANG = False


class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        self._json({"models": [{"name": "mock:latest"}, {"name": "qwen2.5:7b"}]})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(n) or b"{}")
        user = req["messages"][-1]["content"]
        m = re.search(r"Facts for this year:\n(\{.*\})", user, re.S)
        f = json.loads(m.group(1)) if m else {}
        N[0] += 1
        happened = f.get("what_happened") or []
        world = f.get("world") or []
        parts = []
        if world:
            parts.append(f"{f.get('year')}: {world[0]} reaches {f.get('place')}.")
        parts.append(happened[0] if happened else "The days repeat, as days do.")
        parts.append(f"You are {f.get('you', '').split(',')[1].strip() if ',' in f.get('you', '') else 'here'}, and your heart is {f.get('heart')}.")
        if N[0] % 5 == 0:
            parts.append("Agnes from the next street brings bread.")   # a stranger: the guard must reject this
        text = " ".join(parts)
        if HANG:
            time.sleep(10_000)
        if not req.get("stream", True):
            self._json({"message": {"role": "assistant", "content": text}}); return
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "application/x-ndjson"); self.end_headers()
        for w in re.findall(r"\S+\s*", text):
            self.wfile.write((json.dumps({"message": {"role": "assistant", "content": w}, "done": False}) + "\n").encode()); self.wfile.flush()
            time.sleep(0.02)
        self.wfile.write((json.dumps({"message": {"role": "assistant", "content": ""}, "done": True}) + "\n").encode())

    def _json(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 11434
    HANG = len(sys.argv) > 2 and sys.argv[2] == "hang"
    print("mock ollama on", port, flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
