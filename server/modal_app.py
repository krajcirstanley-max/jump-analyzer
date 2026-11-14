"""Modal deployment: a small EU web API takes the upload, a GPU container runs the job.

The upload goes to the API rather than through a function argument because inputs over
2 MiB are stored in us-east, and the clip should neither leave the EU nor outlive the job.
"""
import os
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
CLIPS = "/clips"
SITE = "/usr/local/lib/python3.12/site-packages/nvidia"
ORT_BIN = "/app/server/node_modules/onnxruntime-node/bin/napi-v6/linux/x64"

# GPU memory snapshots are alpha and Modal does not document whether they capture a child
# process, which is where the models live. Turn on only after a plain deploy works; boot
# health-checks the restored process and starts a fresh one if it came back broken.
SNAPSHOT = False

# The one place the GPU is chosen, e.g. "H100" or "L4". Both run the CUDA 13 build below.
GPU = "H100"
# Pinned: 2.1.280+ is needed for claude-opus-5-5, and the build checks it still has --safe-mode.
CLAUDE_CODE = "2.1.314"

# onnxruntime-node 1.31.1 calls its Linux GPU build "cuda12", but the binary links CUDA 13
# (libcudart.so.13, libcublas*.so.13, libcurand.so.10; cuDNN 9 is loaded at run time), read
# from the NuGet package's ELF headers. CUDA 13 wheels put their libraries in nvidia/cu13/lib.
CUDA_WHEELS = [
    "nvidia-cuda-runtime==13.0.96",
    "nvidia-cublas==13.0.2.14",
    "nvidia-curand==10.4.0.35",
    "nvidia-cudnn-cu13==9.13.1.26",
]
MODELS = ["yolox_tiny_humanart.onnx", "rtmpose_m_halpe26_256x192.onnx", "rtmw_l_384x288.onnx"]

# Same ffmpeg major as the Mac the fixtures were made on, so the HDR-to-RGB pixels match.
FFMPEG_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz"
NODE_URL = "https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz"

gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("curl", "xz-utils", "ca-certificates", "libgomp1", "zlib1g")
    .run_commands(
        f"curl -fsSL {FFMPEG_URL} | tar xJ --strip-components=2 -C /usr/local/bin --wildcards '*/bin/ffmpeg' '*/bin/ffprobe'",
        f"curl -fsSL {NODE_URL} | tar xJ --strip-components=1 -C /usr/local",
    )
    .pip_install(*CUDA_WHEELS, "pywebpush==2.5.0")
    .env({
        "LD_LIBRARY_PATH": ":".join([ORT_BIN, f"{SITE}/cu13/lib", f"{SITE}/cudnn/lib"]),
        "PYTHONPATH": "/app/server",
        "JUMP_PROVIDER": "cuda",
        "JUMP_FRAME_BUDGET_GB": "13",
        "JUMP_MODELS_DIR": "/app/models",
    })
    .add_local_file(ROOT / "server/package.json", "/app/server/package.json", copy=True)
    .add_local_file(ROOT / "server/package-lock.json", "/app/server/package-lock.json", copy=True)
    .run_commands(
        "cd /app/server && ONNXRUNTIME_NODE_INSTALL=cuda12 npm ci --no-audit --no-fund",
        # Fails the build naming the missing library, instead of a job silently running on
        # CPU later. libcuda and libnvidia-* come from the host driver at run time.
        f"cd {ORT_BIN} && ldd libonnxruntime_providers_cuda.so | grep 'not found' | grep -v -E 'libcuda[.]so|libnvidia' > /tmp/missing || true; cat /tmp/missing; test ! -s /tmp/missing",
        f"npm install -g --no-audit --no-fund @anthropic-ai/claude-code@{CLAUDE_CODE}",
        "claude --help | grep -q -- --safe-mode",
        "ffmpeg -hide_banner -version | head -1 && node -v && claude --version",
    )
)
# Baked in: one step fewer than a Volume, and the models can't drift from the code.
for m in MODELS:
    gpu_image = gpu_image.add_local_file(ROOT / "models" / m, f"/app/models/{m}", copy=True)
# Code last, so an edit does not rebuild anything above.
gpu_image = (
    gpu_image
    .add_local_file(ROOT / "package.json", "/app/package.json")
    .add_local_dir(ROOT / "js", "/app/js")
    .add_local_dir(ROOT / "server", "/app/server", ignore=lambda p: "node_modules" in p.parts or "__pycache__" in p.parts or p.name.startswith("test_") or p.name == "README.md")
)

api_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi==0.162.2")
    .env({"PYTHONPATH": "/app/server"})
    .add_local_file(ROOT / "server/api.py", "/app/server/api.py")
    .add_local_file(ROOT / "server/worker.py", "/app/server/worker.py")
)

app = modal.App("jump-analyzer")
jobs = modal.Dict.from_name("jump-jobs", create_if_missing=True)
clips = modal.Volume.from_name("jump-clips", create_if_missing=True)
tokens_secret = modal.Secret.from_name("jump-tokens")
vapid_secret = modal.Secret.from_name("jump-vapid")
# JUMP_CLAUDE_TOKENS maps app user to that person's own token; ANTHROPIC_API_KEY is optional.
claude_secret = modal.Secret.from_name("jump-claude")


@app.cls(
    image=gpu_image,
    gpu=GPU,
    region="eu",
    cpu=4.0,
    memory=16384,
    volumes={CLIPS: clips},
    secrets=[vapid_secret, claude_secret],
    scaledown_window=60,
    timeout=450,
    retries=modal.Retries(max_retries=1, initial_delay=1.0, backoff_coefficient=1.0),
    max_containers=2,
    enable_memory_snapshot=SNAPSHOT,
    experimental_options={"enable_gpu_snapshot": True} if SNAPSHOT else None,
)
@modal.concurrent(max_inputs=4)  # the warm-up and a job share a container; jobs still run one at a time
class Analyzer:
    @modal.enter(snap=SNAPSHOT)
    def boot(self):
        import threading

        from worker import Daemon, daemon_env

        self.lock = threading.Lock()
        self.daemon = Daemon(["node", "/app/server/analyze.mjs", "--serve"], cwd="/app", env=daemon_env())
        self.report(self.daemon.start())

    @modal.enter(snap=False)
    def after_restore(self):
        if not SNAPSHOT:
            return
        try:
            self.daemon.run({"ping": True}, stall=30, limit=30)
        except Exception as e:
            print("restored process is unusable, starting a new one:", repr(e))
            self.report(self.daemon.restart())

    @staticmethod
    def report(info):
        print("analysis process ready:", info)
        heavy = (info.get("msPerRun") or {}).get("rtmw-l-384", 0)
        if info.get("provider") != "cuda" or heavy > 150:
            print(f"WARNING: rtmw-l-384 took {heavy} ms per run; this looks like CPU, not the GPU.")

    @modal.method()
    def warm(self):
        return self.daemon.info

    # A training session: stay up while the deadline in the jobs dict is ahead (api.py /warm with
    # minutes). The method timeout is 450 s, so a hold hands over to a fresh one before it.
    @modal.method()
    def hold(self):
        import time

        t0 = time.time()
        while time.time() - t0 < 380:
            if time.time() >= float(jobs.get("warm:until") or 0):
                return "cooled"
            jobs["warm:beat"] = time.time()
            time.sleep(15)
        if time.time() < float(jobs.get("warm:until") or 0):
            jobs["warm:beat"] = time.time()
            Analyzer().hold.spawn()
        return "handed over"

    @modal.method()
    def run(self, job_id, owner, params):
        from worker import claude_token_for, make_push, process_job

        push = make_push(jobs, os.environ.get("VAPID_PRIVATE"), os.environ.get("VAPID_SUB"))
        with self.lock:
            return process_job(job_id, owner, params, jobs=jobs, clips_dir=CLIPS, reload_clips=clips.reload, commit_clips=clips.commit, daemon=self.daemon, push=push,
                               claude_token=claude_token_for(owner, os.environ.get("JUMP_CLAUDE_TOKENS")))

    @modal.exit()
    def stop(self):
        self.daemon.stop()


@app.function(
    image=api_image,
    region="eu",
    routing_region="eu-west",
    cpu=1.0,
    memory=1024,
    volumes={CLIPS: clips},
    secrets=[tokens_secret, vapid_secret],
    scaledown_window=300,
    timeout=1800,  # a slow connection on the biggest allowed clip
)
@modal.concurrent(max_inputs=32)
@modal.asgi_app()
def web():
    from api import create_api, load_tokens

    return create_api(
        jobs=jobs,
        clips_dir=CLIPS,
        commit_clips=clips.commit,
        start_job=lambda job_id, owner, params: Analyzer().run.spawn(job_id, owner, params),
        warm=lambda: Analyzer().warm.spawn(),
        hold=lambda: Analyzer().hold.spawn(),
        tokens=load_tokens(os.environ.get("JUMP_TOKENS")),
        push_key=os.environ.get("VAPID_PUBLIC", ""),
    )


@app.function(image=api_image, region="eu", volumes={CLIPS: clips}, schedule=modal.Period(hours=1))
def sweep():
    """Deletes clips left behind by a container that died before it could."""
    from worker import sweep_clips

    clips.reload()
    print("clips removed:", sweep_clips(CLIPS, clips.commit))
