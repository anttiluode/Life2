"""
Life2 local painter: text-to-image on your own GPU, for the game page to call.

    pip install torch diffusers transformers accelerate pillow
    python local/painter_server.py                 # SDXL-Turbo, port 7861
    python local/painter_server.py --model stabilityai/sd-turbo      # smaller, faster
    python local/painter_server.py --mock          # no GPU: placeholder pictures, for testing

The game (Settings -> Painter -> Local) sends POST /paint with
    {"prompt": ..., "negative": ..., "seed": int, "width": 768, "height": 512}
and gets back {"image": "data:image/png;base64,..."}.

SDXL-Turbo at 768x512 with 2 steps takes about 1-2 s on an RTX 3060 (12 GB) in fp16.
Only one image is made at a time; requests queue.

The narrator (Ollama) shares the same graphics card. If both models don't fit in its memory,
Windows quietly lends the GPU system RAM and painting becomes 10-20x slower. The server times
every picture and says so when that happens. Comfortable pairs on 12 GB:
    SDXL-Turbo (~7 GB) + qwen2.5:3b (~2.5 GB)      or      SD-Turbo (~3 GB) + qwen2.5:7b (~5 GB)
"""
import argparse
import base64
import io
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
LAST = [None]          # seconds the last picture took
PIPE = None
ARGS = None


def load(model):
    import torch
    from diffusers import AutoPipelineForText2Image
    pipe = AutoPipelineForText2Image.from_pretrained(model, torch_dtype=torch.float16, variant="fp16")
    pipe.to("cuda")
    try:
        pipe.enable_vae_slicing()
    except Exception:
        pass
    return pipe


def paint_real(req):
    import torch
    w = int(req.get("width", 768)) // 8 * 8
    h = int(req.get("height", 512)) // 8 * 8
    g = torch.Generator("cuda").manual_seed(int(req.get("seed", 0)) % (2 ** 31))
    turbo = "turbo" in ARGS.model
    img = PIPE(prompt=req["prompt"], negative_prompt=None if turbo else req.get("negative"),
               num_inference_steps=ARGS.steps, guidance_scale=0.0 if turbo else 6.0,
               width=w, height=h, generator=g).images[0]
    return img


def gpu_memory():
    """(used GB, total GB) for the whole card, all programs together, or None."""
    try:
        import torch
        free, total = torch.cuda.mem_get_info()
        return round((total - free) / 2**30, 1), round(total / 2**30, 1)
    except Exception:
        return None


def paint_mock(req):
    """A soft placeholder picture that still changes with the prompt and seed."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None
    import hashlib
    w, h = int(req.get("width", 768)), int(req.get("height", 512))
    hsh = hashlib.sha256((req["prompt"] + str(req.get("seed", 0))).encode()).digest()
    warm = "golden" in req["prompt"]
    cold = "blue-grey" in req["prompt"]
    base = (196, 160, 104) if warm else (110, 128, 140) if cold else (150, 146, 120)
    img = Image.new("RGB", (w, h), base)
    d = ImageDraw.Draw(img)
    for k in range(14):
        x, y = hsh[k] / 255 * w, hsh[k + 14] / 255 * h
        r = 30 + hsh[(k + 7) % 32] / 255 * 120
        c = tuple(max(0, min(255, base[i] + (hsh[(k * 3 + i) % 32] - 128) // 3)) for i in range(3))
        d.ellipse([x - r, y - r, x + r, y + r], fill=c)
    text = ". ".join(req["prompt"].split(". ")[1:])[:90]
    d.rectangle([0, h - 40, w, h], fill=(20, 22, 20))
    d.text((12, h - 30), "mock painter: " + text, fill=(230, 220, 200))
    return img


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Chrome asks before an https page may talk to localhost
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            mem = None if ARGS.mock else gpu_memory()
            self._json(200, {"ok": True, "model": "mock" if ARGS.mock else ARGS.model,
                             "gpu_used_gb": mem and mem[0], "gpu_total_gb": mem and mem[1], "last_seconds": LAST[0]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/paint"):
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            if not req.get("prompt"):
                return self._json(400, {"error": "prompt missing"})
            with LOCK:
                t0 = time.time()
                img = paint_mock(req) if ARGS.mock else paint_real(req)
                dt = time.time() - t0
                LAST[0] = round(dt, 1)
            mem = None if ARGS.mock else gpu_memory()
            note = f"painted in {dt:.1f} s" + (f", GPU memory {mem[0]} of {mem[1]} GB in use" if mem else "")
            if dt > 8 and not ARGS.mock:
                note += ("  <-- SLOW: the card is probably out of memory and borrowing system RAM. "
                         "Use a smaller narrator (qwen2.5:3b) or restart this with --model stabilityai/sd-turbo")
            print(note, flush=True)
            if img is None:
                return self._json(500, {"error": "could not draw (install pillow for --mock)"})
            buf = io.BytesIO()
            img.save(buf, format="PNG" if ARGS.mock else "JPEG", quality=90)
            mime = "png" if ARGS.mock else "jpeg"
            self._json(200, {"image": f"data:image/{mime};base64," + base64.b64encode(buf.getvalue()).decode(), "seconds": LAST[0]})
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            print("the game stopped waiting for this picture (it gives up after 3 minutes)", flush=True)
        except Exception as e:  # report, don't crash the server
            try:
                self._json(500, {"error": str(e)})
            except OSError:
                pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("painter: " + (fmt % args) + "\n")


def main():
    global PIPE, ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="stabilityai/sdxl-turbo")
    ap.add_argument("--steps", type=int, default=2)
    ap.add_argument("--port", type=int, default=7861)
    ap.add_argument("--mock", action="store_true")
    ARGS = ap.parse_args()
    if not ARGS.mock:
        print(f"loading {ARGS.model} ...", flush=True)
        PIPE = load(ARGS.model)
        mem = gpu_memory()
        if mem:
            print(f"GPU memory {mem[0]} of {mem[1]} GB in use (all programs)", flush=True)
    print(f"painter ready on http://localhost:{ARGS.port} ({'mock' if ARGS.mock else ARGS.model})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
