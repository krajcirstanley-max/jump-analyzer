"""The job API. No Modal imports: storage and job start are injected, so it runs under test."""
import hmac
import json
import re
import secrets as pysecrets
import time
from pathlib import Path

MAX_UPLOAD = 300 * 1024 * 1024
STALE_S = 360  # no update for this long means the worker died without saying so
# A queued job waits for a free container, and each job holds one through its coaching text (up to
# 3 min): ten jumps picked at once queued past 6 min and were called dead (2026-11-19, 2 of 3 in a test).
QUEUE_STALE_S = 1800
MAX_DEVICES = 5
CLIP_ID = re.compile(r"[A-Za-z0-9_-]{1,40}")  # the app's own id for a video (sp1794744449246)
CLIP_KEEP_S = 7 * 24 * 3600  # a job is followed for a week at most

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
    "recap_story": "Scenár videa má zlý formát.",
    "recap_clips": "Chýbajú klipy k videu.",
    "recap_start": "Video sa nepodarilo spustiť. Skús to znova.",
    "recap_missing": "Toto video neexistuje alebo už bolo zmazané.",
    "recap_wait": "Video ešte nie je hotové.",
}
MAX_RECAP_CLIPS = 12
MAX_STORY = 8 * 1024 * 1024


def recap_key(rid):
    return f"recap:{rid}"


def job_key(job_id):
    return f"job:{job_id}"


def clip_key(owner, clip):
    return f"clip:{owner}:{clip}"


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
        pb = a.get("pb") or 0
        if not isinstance(pb, (int, float)) or not 1 <= pb <= 12:
            pb = 0  # a PB outside 1-12 m is a typo; no distance expectation then
        out.append({"id": aid, "sex": sex, "name": name, "history": history[-5:], **({"height": height} if height else {}), **({"pb": pb} if pb else {})})
    return out


# A training session keeps one GPU container up (Stanley, 2026-11-14: "viem kliknúť začať tréning
# a potom sa to automaticky zohreje"): the cold start is about 3 minutes, a jump every 3-5 minutes.
# The deadline lives in the jobs dict, so it holds while the phone is locked in a pocket; the hold
# on the GPU side checks it (modal_app.Analyzer.hold). Capped, and every analysis extends it.
HOLD_MAX_MIN = 45
HOLD_STALE_S = 45   # no heartbeat for this long: the hold is gone, start a new one
HOLD_BOOT_S = 240   # a new hold's claim covers the GPU's cold start (~3 min) before its first beat


def create_api(jobs, clips_dir, commit_clips, start_job, warm, tokens, push_key="", now=time.time, hold=None, chat=None, start_recap=None, reload_clips=None):
    from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
    from fastapi.responses import FileResponse
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

    def warm_state():
        t, until, beat = now(), float(jobs.get("warm:until") or 0), float(jobs.get("warm:beat") or 0)
        return {"ok": True, "until": until if until > t else 0, "hot": t - beat <= HOLD_STALE_S}

    # minutes > 0: hold the GPU warm until then (a training session); 0: one warm-up as before.
    @api.post("/warm")
    def warm_up(minutes: float = Query(0), _=Depends(user)):
        try:
            if minutes > 0 and hold is not None:
                t = now()
                jobs["warm:until"] = max(float(jobs.get("warm:until") or 0), t + min(minutes, HOLD_MAX_MIN) * 60)
                if t - float(jobs.get("warm:beat") or 0) > HOLD_STALE_S:
                    # claimed into the future: taps during the ~3 min boot must not start more holds
                    jobs["warm:beat"] = t + HOLD_BOOT_S - HOLD_STALE_S
                    hold()
                return warm_state()
            warm()
        except Exception as e:  # a failed warm-up only costs the cold start
            print("warm-up failed:", e)
        return {"ok": True}

    @api.get("/warm")
    def warm_status(_=Depends(user)):
        return warm_state()

    # "Opýtaj sa": one question about one jump (chat.py). chat(owner, payload) -> {"answer": str}.
    @api.post("/chat")
    async def ask(request: Request, who=Depends(user)):
        if chat is None:
            raise HTTPException(503, "Chat nie je na serveri zapnutý.")
        raw = await request.body()
        if len(raw) > 60_000:
            raise HTTPException(413, "Otázka je príliš dlhá.")
        try:
            payload = json.loads(raw or b"{}")
        except ValueError:
            raise HTTPException(400, "Zlá požiadavka.")
        try:
            return await run_in_threadpool(chat, who, payload)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            print("chat failed:", type(e).__name__, str(e)[:200])
            raise HTTPException(502, str(e) if isinstance(e, RuntimeError) else "Odpoveď sa nepodarilo získať, skús znova.")

    @api.post("/cool")
    def cool(_=Depends(user)):
        jobs["warm:until"] = 0
        return {"ok": True, "until": 0}

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
        clip: str = Query(""),
        who: str = Query(""),
        owner=Depends(user),
    ):
        if clip and not CLIP_ID.fullmatch(clip):
            clip = ""  # the app's own id for the video; anything else is ignored
        if mode not in ("jump", "rsi", "sprint"):
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
            if clip:
                jobs.put(clip_key(owner, clip), {"jobId": job_id, "at": t})
            try:
                start_job(job_id, owner, {"sex": sex, "name": name, "history": past[-5:], **({"height": height} if height else {}),
                                          **({"mode": mode} if mode != "jump" else {}), **({"boxCm": box} if box else {}),
                                          **({"athletes": roster} if roster else {}),
                                          # the athlete the phone already knows (a Freelap chip heard): no need to look
                                          **({"who": who} if who and any(a.get("id") == who for a in roster) else {})})
            except Exception as e:
                print("job start failed:", e)
                path.unlink(missing_ok=True)
                commit_clips()
                jobs.put(job_key(job_id), {"state": "error", "error": SK["start"], "owner": owner, "createdAt": t, "updatedAt": now()})
                raise HTTPException(503, SK["start"])

        await run_in_threadpool(start)
        return {"jobId": job_id}

    @api.get("/jobs/clip/{clip}")
    def job_of_clip(clip: str, owner=Depends(user)):
        """The job made from this clip of the app's: a retry after a lost answer follows it."""
        hit = jobs.get(clip_key(owner, clip)) if CLIP_ID.fullmatch(clip) else None
        job = hit and jobs.get(job_key(hit["jobId"]))
        if not job or job.get("owner") != owner or now() - hit.get("at", 0) > CLIP_KEEP_S:
            raise HTTPException(404, SK["missing"])
        return {"jobId": hit["jobId"], "state": job.get("state")}

    @api.get("/jobs/{job_id}")
    def get_job(job_id: str, omit: str = Query(""), owner=Depends(user)):
        job = jobs.get(job_key(job_id))
        if not job or job.get("owner") != owner:  # someone else's job looks like no job
            raise HTTPException(404, SK["missing"])
        t = now()
        if job["state"] in ("queued", "running") and t - job.get("updatedAt", 0) > (QUEUE_STALE_S if job["state"] == "queued" else STALE_S):
            # A worker that died during coaching still leaves a good result behind.
            ended = {"state": "done", "stage": "done", "done": 1, "total": 1, "coach": None} if job.get("result") else {"state": "error", "error": SK["stale"]}
            job = {**job, **ended, "updatedAt": t}
            jobs.put(job_key(job_id), job)
        jobs.put(poll_key(job_id), t)  # the push is skipped while the app is watching
        # omit=result: a client that already has the ~1 MB result stops downloading it each poll.
        fields = ("state", "stage", "done", "total", "coach", "error") if omit == "result" else ("state", "stage", "done", "total", "result", "coach", "error")
        return {k: v for k, v in job.items() if k in fields}

    # ---------- "Video z tréningu": clips, then the story the app wrote, then the rendered video ----------
    RID = re.compile(r"[A-Za-z0-9_-]{16,40}")

    def recap_of(rid, owner):
        job = jobs.get(recap_key(rid)) if RID.fullmatch(rid) else None
        if not job or job.get("owner") != owner:
            raise HTTPException(404, SK["recap_missing"])
        return job

    @api.post("/recap")
    def recap_new(clips: int = Query(...), owner=Depends(user)):
        if not 1 <= clips <= MAX_RECAP_CLIPS:
            raise HTTPException(400, SK["recap_clips"])
        rid = pysecrets.token_urlsafe(16)
        t = now()
        jobs.put(recap_key(rid), {"state": "uploading", "owner": owner, "clips": clips, "got": [], "createdAt": t, "updatedAt": t})
        return {"recapId": rid}

    @api.post("/recap/{rid}/clip/{k}")
    async def recap_clip(rid: str, k: int, request: Request, owner=Depends(user)):
        job = recap_of(rid, owner)
        if job.get("state") != "uploading" or not 0 <= k < job["clips"]:
            raise HTTPException(400, SK["recap_clips"])
        path = clips_dir / f"recap-{rid}-c{k}"
        size = 0
        try:
            with open(path, "wb") as f:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        raise HTTPException(413, SK["too_big"])
                    f.write(chunk)
            if not size:
                raise HTTPException(400, SK["empty"])
        except (HTTPException, ClientDisconnect):
            path.unlink(missing_ok=True)
            raise
        job = jobs.get(recap_key(rid)) or job
        job["got"] = sorted(set(job.get("got", [])) | {k})
        job["updatedAt"] = now()
        jobs.put(recap_key(rid), job)
        return {"ok": True}

    @api.post("/recap/{rid}/render")
    async def recap_render(rid: str, request: Request, owner=Depends(user)):
        job = recap_of(rid, owner)
        body = await request.body()
        if len(body) > MAX_STORY:
            raise HTTPException(413, SK["recap_story"])
        try:
            story = json.loads(body)
            ok = isinstance(story, dict) and isinstance(story.get("frames"), list) and 0 < len(story["frames"]) <= 4000 and isinstance(story.get("clips"), list) and len(story["clips"]) == job["clips"]
        except ValueError:
            ok = False
        if not ok:
            raise HTTPException(400, SK["recap_story"])
        if sorted(job.get("got", [])) != list(range(job["clips"])):
            raise HTTPException(400, SK["recap_clips"])
        (clips_dir / f"recap-{rid}.json").write_bytes(body)

        def start():
            commit_clips()
            jobs.put(recap_key(rid), {**job, "state": "queued", "updatedAt": now()})
            try:
                start_recap(rid, owner)
            except Exception as e:
                print("recap start failed:", e)
                jobs.put(recap_key(rid), {**job, "state": "error", "error": SK["recap_start"], "updatedAt": now()})
                raise HTTPException(503, SK["recap_start"])

        await run_in_threadpool(start)
        return {"ok": True}

    @api.get("/recap/{rid}")
    def recap_state(rid: str, owner=Depends(user)):
        job = recap_of(rid, owner)
        if job["state"] in ("queued", "running") and now() - job.get("updatedAt", 0) > 900:
            job = {**job, "state": "error", "error": SK["recap_start"]}
            jobs.put(recap_key(rid), job)
        return {k: v for k, v in job.items() if k in ("state", "error", "seconds", "done", "total", "got", "clips")}

    @api.get("/recap/{rid}/video")
    def recap_video(rid: str, owner=Depends(user)):
        job = recap_of(rid, owner)
        if job.get("state") != "done":
            raise HTTPException(409, SK["recap_wait"])
        path = clips_dir / f"recap-{rid}.mp4"
        for _ in range(3):   # the render container's commit can land a moment after its "done"
            if path.exists():
                break
            if reload_clips:
                reload_clips()
            if not path.exists():
                time.sleep(1)
        if not path.exists():
            raise HTTPException(404, SK["recap_missing"])
        return FileResponse(path, media_type="video/mp4", filename="trening.mp4")

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
