"""The job API. No Modal imports: storage and job start are injected, so it runs under test."""
import hmac
import json
import secrets as pysecrets
import time
from pathlib import Path

MAX_UPLOAD = 300 * 1024 * 1024
STALE_S = 360  # no update for this long means the worker died without saying so
MAX_DEVICES = 5

SK = {
    "auth": "Prístupový kľúč nie je platný.",
    "too_big": "Video je väčšie ako 300 MB. Skráť ho a skús to znova.",
    "empty": "Server nedostal žiadne video.",
    "sex": "Neplatné pohlavie.",
    "mode": "Neznámy druh analýzy.",
    "name": "Meno je príliš dlhé.",
    "history": "História pokusov má zlý formát.",
    "athletes": "Zoznam atlétov má zlý formát.",
    "missing": "Táto analýza neexistuje.",
    "start": "Analýzu sa nepodarilo spustiť. Skús to znova.",
    "stale": "Analýza sa na serveri prerušila. Skús to znova.",
    "sub": "Neplatné prihlásenie na upozornenia.",
}


def job_key(job_id):
    return f"job:{job_id}"


def poll_key(job_id):
    return f"poll:{job_id}"


def subs_key(owner):
    return f"subs:{owner}"


def load_tokens(raw):
    """JUMP_TOKENS is {"stanley": "<token>", "miska": "<token>"}."""
    tokens = json.loads(raw or "{}")
    return {user: tok for user, tok in tokens.items() if tok}


def owner_of(header, tokens):
    if not header or not header.lower().startswith("bearer "):
        return None
    given = header[7:].strip().encode()
    found = None
    # Every token is compared, so the time taken does not reveal which one was close.
    for user, tok in tokens.items():
        if hmac.compare_digest(given, tok.encode()):
            found = user
    return found


def parse_athletes(raw):
    """The athletes the server may find in the clip (the app has no athlete switch): a JSON list
    of {id, sex, name, height, history}. Empty means the old single-athlete parameters."""
    if not raw:
        return []
    items = json.loads(raw)
    if not isinstance(items, list) or len(items) > 4:
        raise ValueError
    out = []
    for a in items:
        if not isinstance(a, dict):
            raise ValueError
        aid, sex, name = a.get("id"), a.get("sex"), a.get("name", "")
        if not isinstance(aid, str) or not 0 < len(aid) <= 20 or sex not in ("male", "female"):
            raise ValueError
        if not isinstance(name, str) or len(name) > 60:
            raise ValueError
        height = a.get("height") or 0
        if not isinstance(height, (int, float)) or not 120 <= height <= 230:
            height = 0
        history = a.get("history") or []
        if not isinstance(history, list):
            raise ValueError
        out.append({"id": aid, "sex": sex, "name": name, "history": history[-5:], **({"height": height} if height else {})})
    return out


def create_api(jobs, clips_dir, commit_clips, start_job, warm, tokens, push_key="", now=time.time):
    from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
    from fastapi.concurrency import run_in_threadpool
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.middleware.gzip import GZipMiddleware
    from starlette.requests import ClientDisconnect

    clips_dir = Path(clips_dir)
    api = FastAPI(title="jump-analyzer", docs_url=None, redoc_url=None, openapi_url=None)
    # A bearer token, no cookies, so any origin is safe and the Pages URL can change freely.
    api.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"])
    api.add_middleware(GZipMiddleware, minimum_size=1024)

    def user(authorization: str | None = Header(default=None)):
        who = owner_of(authorization, tokens)
        if not who:
            raise HTTPException(401, SK["auth"])
        return who

    @api.get("/health")
    def health():
        return {"ok": True}

    @api.post("/warm")
    def warm_up(_=Depends(user)):
        try:
            warm()
        except Exception as e:  # a failed warm-up only costs the cold start
            print("warm-up failed:", e)
        return {"ok": True}

    @api.post("/jobs")
    async def create_job(
        request: Request,
        sex: str = Query("male"),
        name: str = Query(""),
        history: str = Query(""),
        height: float = Query(0),
        mode: str = Query("jump"),
        box: float = Query(0),
        athletes: str = Query(""),
        owner=Depends(user),
    ):
        if mode not in ("jump", "rsi"):
            raise HTTPException(400, SK["mode"])
        if box and not 5 <= box <= 120:
            box = 0  # a box height outside 5-120 cm is a typo; the app asks again
        if sex not in ("male", "female"):
            raise HTTPException(400, SK["sex"])
        if len(name) > 60:
            raise HTTPException(400, SK["name"])
        if height and not 120 <= height <= 230:
            height = 0  # nonsense is ignored; the analysis falls back to a typical height
        try:
            past = json.loads(history) if history else []
            if not isinstance(past, list):
                raise ValueError
        except ValueError:
            raise HTTPException(400, SK["history"])
        try:
            roster = parse_athletes(athletes)
        except ValueError:
            raise HTTPException(400, SK["athletes"])
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_UPLOAD:
            raise HTTPException(413, SK["too_big"])

        job_id = pysecrets.token_urlsafe(16)
        path = clips_dir / job_id
        size = 0
        try:
            with open(path, "wb") as f:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_UPLOAD:  # Content-Length can be absent or wrong
                        raise HTTPException(413, SK["too_big"])
                    f.write(chunk)
            if not size:
                raise HTTPException(400, SK["empty"])
        except (HTTPException, ClientDisconnect):
            path.unlink(missing_ok=True)
            raise

        def start():
            commit_clips()
            t = now()
            jobs.put(job_key(job_id), {"state": "queued", "stage": "queued", "done": 0, "total": 1, "owner": owner, "createdAt": t, "updatedAt": t})
            try:
                start_job(job_id, owner, {"sex": sex, "name": name, "history": past[-5:], **({"height": height} if height else {}),
                                          **({"mode": "rsi"} if mode == "rsi" else {}), **({"boxCm": box} if box else {}),
                                          **({"athletes": roster} if roster else {})})
            except Exception as e:
                print("job start failed:", e)
                path.unlink(missing_ok=True)
                commit_clips()
                jobs.put(job_key(job_id), {"state": "error", "error": SK["start"], "owner": owner, "createdAt": t, "updatedAt": now()})
                raise HTTPException(503, SK["start"])

        await run_in_threadpool(start)
        return {"jobId": job_id}

    @api.get("/jobs/{job_id}")
    def get_job(job_id: str, omit: str = Query(""), owner=Depends(user)):
        job = jobs.get(job_key(job_id))
        if not job or job.get("owner") != owner:  # someone else's job looks like no job
            raise HTTPException(404, SK["missing"])
        t = now()
        if job["state"] in ("queued", "running") and t - job.get("updatedAt", 0) > STALE_S:
            # A worker that died during coaching still leaves a good result behind.
            ended = {"state": "done", "stage": "done", "done": 1, "total": 1, "coach": None} if job.get("result") else {"state": "error", "error": SK["stale"]}
            job = {**job, **ended, "updatedAt": t}
            jobs.put(job_key(job_id), job)
        jobs.put(poll_key(job_id), t)  # the push is skipped while the app is watching
        # omit=result: a client that already has the ~1 MB result stops downloading it each poll.
        fields = ("state", "stage", "done", "total", "coach", "error") if omit == "result" else ("state", "stage", "done", "total", "result", "coach", "error")
        return {k: v for k, v in job.items() if k in fields}

    @api.get("/push/key")
    def key(_=Depends(user)):
        return {"publicKey": push_key}

    @api.post("/push/subscribe")
    def subscribe(sub: dict, owner=Depends(user)):
        endpoint, keys = sub.get("endpoint"), sub.get("keys") or {}
        if not isinstance(endpoint, str) or not endpoint.startswith("https://") or not keys.get("p256dh") or not keys.get("auth"):
            raise HTTPException(400, SK["sub"])
        kept = [s for s in (jobs.get(subs_key(owner)) or []) if s.get("endpoint") != endpoint]
        kept.append({"endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]}})
        jobs.put(subs_key(owner), kept[-MAX_DEVICES:])
        return {"ok": True}

    return api
