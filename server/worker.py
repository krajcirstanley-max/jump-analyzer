"""Runs jobs on the GPU container: drives the Node process, reports to the job store, sends the push."""
import json
import os
import queue
import subprocess
import threading
import time
from pathlib import Path

from api import job_key, poll_key, subs_key

STALL_S = 120   # no line from Node for this long means it hung
COACH_STALL_S = 200  # the coaching step is silent, and coach.mjs may take two 90 s attempts
JOB_LIMIT_S = 400  # pose ~20 s, Claude naming the frames up to 2x60 s, coaching up to 2x90 s
WATCHING_S = 6  # a poll this recent means the app is open and the screen already shows it

FAILED = "Analýza na serveri zlyhala. Skús to znova."
NO_CLIP = "Video sa na serveri nenašlo. Nahraj ho znova."
LOST_RESULT = "Server nevrátil výsledok analýzy. Skús to znova."

# The Node process needs none of these; the token map must never reach it or its children.
HIDDEN_FROM_NODE = {"JUMP_CLAUDE_TOKENS", "JUMP_TOKENS", "VAPID_PRIVATE", "VAPID_PUBLIC", "VAPID_SUB"}


def daemon_env():
    return {k: v for k, v in os.environ.items() if k not in HIDDEN_FROM_NODE}


def claude_token_for(owner, raw):
    """That person's own token or None. Never raises, never logs, never returns anyone else's."""
    try:
        token = json.loads(raw or "{}").get(owner)
    except (ValueError, AttributeError):
        print("JUMP_CLAUDE_TOKENS is not valid JSON; using the fallback coaching.")
        return None
    return token if isinstance(token, str) and token else None


class Daemon:
    """server/analyze.mjs --serve: keeps the models on the GPU between jobs."""

    def __init__(self, cmd, cwd=None, env=None):
        self.cmd, self.cwd, self.env, self.proc, self.lines, self.info, self.seq = cmd, cwd, env, None, None, {}, 0

    def start(self, timeout=180):
        self.proc = subprocess.Popen(self.cmd, cwd=self.cwd, env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.lines = queue.Queue()
        out = self.proc.stdout
        threading.Thread(target=self._read, args=(out, self.lines), daemon=True).start()
        while True:
            msg = self._next(timeout)
            if msg.get("ready"):
                self.info = msg
                return msg

    @staticmethod
    def _read(out, lines):
        for line in out:
            line = line.strip()
            if not line:
                continue
            try:
                lines.put(json.loads(line))
            except ValueError:  # a stray library print must not break the protocol
                print("node:", line)
        lines.put(None)

    def _next(self, timeout):
        try:
            msg = self.lines.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError("analysis process stopped responding")
        if msg is None:
            raise RuntimeError("analysis process exited")
        return msg

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()

    def restart(self):
        self.stop()
        return self.start()

    def alive(self):
        return bool(self.proc) and self.proc.poll() is None

    def run(self, job, on_progress=None, on_result=None, stall=STALL_S, limit=JOB_LIMIT_S):
        self.seq += 1
        job = {**job, "id": self.seq}
        self.proc.stdin.write(json.dumps(job) + "\n")
        self.proc.stdin.flush()
        deadline = time.monotonic() + limit
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("job time limit")
            msg = self._next(min(stall, left))
            if msg.get("id") != self.seq:
                continue
            if "progress" in msg:
                if on_progress:
                    on_progress(msg["progress"])
            elif "result" in msg:
                stall = max(stall, COACH_STALL_S)
                if on_result:
                    on_result(msg)
            elif msg.get("error"):
                raise RuntimeError(msg["error"])
            elif msg.get("done"):
                return msg


def process_job(job_id, owner, params, *, jobs, clips_dir, reload_clips, commit_clips, daemon, push, claude_token=None, tmp="/tmp", now=time.time):
    """Runs one job start to finish. Only ordinary failures land here: if the container is
    preempted the clip stays put, so Modal's retry can run the job again.
    claude_token goes to the Node process only; it is never put in the job record."""
    key = job_key(job_id)
    record = jobs.get(key) or {"owner": owner, "createdAt": now()}
    def update(**fields):
        record.update(fields, updatedAt=now())
        jobs.put(key, record)

    clip = Path(clips_dir) / job_id
    out = Path(tmp) / f"{job_id}.json"
    outcome = {}
    got_result = False
    fallback = None

    def on_result(msg):
        nonlocal got_result, fallback
        got_result, fallback = True, msg.get("coachFallback")
        update(state="running", stage="coach", done=0, total=1, result=msg["result"])

    try:
        reload_clips()
        if not clip.exists():
            raise FileNotFoundError(NO_CLIP)
        update(state="running", stage="Loading models", done=0, total=1)
        if not daemon.alive():
            daemon.start()
        job = {"clip": str(clip), "out": str(out), **params}
        if claude_token:
            job["claudeToken"] = claude_token
        daemon.run(job, on_result=on_result,
                   on_progress=lambda p: update(state="running", stage=p.get("stage"), done=p.get("done", 0), total=p.get("total", 1)))
        data = json.loads(out.read_text())
        if data.get("error"):
            outcome = {"state": "error", "error": data["error"]}
        elif not (data.get("result") or got_result):
            outcome = {"state": "error", "error": LOST_RESULT}
        else:
            outcome = {"state": "done", "stage": "done", "done": 1, "total": 1, "coach": data.get("coach"), "ms": data.get("ms")}
            if data.get("result"):
                outcome["result"] = data["result"]
    except Exception as e:
        print(f"job {job_id} failed:", repr(e))
        if got_result:  # the numbers are already saved; only the coaching text is missing
            outcome = {"state": "done", "stage": "done", "done": 1, "total": 1, "coach": fallback}
        else:
            outcome = {"state": "error", "error": NO_CLIP if isinstance(e, FileNotFoundError) and str(e) == NO_CLIP else FAILED}
        # A timed-out job leaves Node mid-work; the next job needs a clean process.
        if isinstance(e, TimeoutError):
            daemon.stop()

    # The clip goes first: the rest can fail without the video staying behind.
    try:
        clip.unlink(missing_ok=True)
        commit_clips()
    except Exception as e:
        print(f"job {job_id}: clip delete failed:", repr(e))
    out.unlink(missing_ok=True)
    update(**outcome)
    try:
        if push and not _watching(jobs, job_id, now()):
            push(owner, job_id, outcome["state"] == "done")
    except Exception as e:
        print(f"job {job_id}: push failed:", repr(e))
    return outcome


def _watching(jobs, job_id, t):
    polled = jobs.get(poll_key(job_id))
    return polled is not None and t - polled < WATCHING_S


def make_push(jobs, private_key, sub):
    """Returns push(owner, job_id, ok), or None when VAPID keys are not configured."""
    if not private_key or not sub:
        return None

    def push(owner, job_id, ok):
        from pywebpush import WebPushException, webpush

        subs = jobs.get(subs_key(owner)) or []
        body = json.dumps({
            "title": "Analýza je hotová" if ok else "Analýza sa nepodarila",
            "body": "Otvor aplikáciu a pozri si výsledok." if ok else "Otvor aplikáciu a skús to znova.",
            "jobId": job_id,
        })
        live = []
        for s in subs:
            try:
                webpush(subscription_info=s, data=body, vapid_private_key=private_key, vapid_claims={"sub": sub}, ttl=3600, headers={"Urgency": "high"})
                live.append(s)
            except WebPushException as e:
                code = getattr(e.response, "status_code", None)
                if code not in (404, 410):  # those two mean the phone unsubscribed
                    print("push error:", code, e)
                    live.append(s)
        if len(live) != len(subs):
            jobs.put(subs_key(owner), live)

    return push


def sweep_clips(clips_dir, commit_clips, max_age_s=3600, now=time.time):
    """Backstop for containers that died before reaching the delete. Returns how many went."""
    removed = 0
    for f in Path(clips_dir).iterdir():
        if f.is_file() and now() - f.stat().st_mtime > max_age_s:
            f.unlink(missing_ok=True)
            removed += 1
    if removed:
        commit_clips()
    return removed
