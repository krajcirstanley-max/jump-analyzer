"""Job API and worker logic against fakes. Needs fastapi and httpx; no Modal, no GPU.
Run: python -m pytest server/test_api.py, or python server/test_api.py."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient  # noqa: E402

import api as A  # noqa: E402
import worker as W  # noqa: E402


class Store(dict):
    def put(self, k, v):
        self[k] = json.loads(json.dumps(v))


class Env:
    def __init__(self, start_fails=False):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name)
        self.jobs, self.started, self.warmed, self.commits = Store(), [], [], [0]
        self.t = [1000.0]
        def start(job_id, owner, params):
            if start_fails:
                raise RuntimeError("no capacity")
            self.started.append((job_id, owner, params))
        def commit():
            self.commits[0] += 1
        self.client = TestClient(A.create_api(
            jobs=self.jobs, clips_dir=self.path, commit_clips=commit, start_job=start,
            warm=lambda: self.warmed.append(1), tokens={"stanley": "tok-s", "miska": "tok-m"},
            push_key="PUB", now=lambda: self.t[0]), raise_server_exceptions=False)
    def post(self, body=b"clip", token="tok-s", q="sex=female&name=Mi%C5%A1ka", **kw):
        return self.client.post(f"/jobs?{q}", content=body, headers={"Authorization": f"Bearer {token}", **kw.pop("headers", {})})
    def get(self, job_id, token="tok-s"):
        return self.client.get(f"/jobs/{job_id}", headers={"Authorization": f"Bearer {token}"})


def test_auth_required_everywhere():
    e = Env()
    assert e.client.post("/jobs", content=b"x").status_code == 401
    assert e.post(token="wrong").status_code == 401
    assert e.get("nope", token="wrong").status_code == 401
    assert e.client.post("/warm").status_code == 401
    assert e.client.get("/push/key").status_code == 401
    assert e.client.get("/health").status_code == 200


def test_create_job_writes_clip_and_starts():
    e = Env()
    r = e.post(b"bytes")
    assert r.status_code == 200
    jid = r.json()["jobId"]
    assert (e.path / jid).read_bytes() == b"bytes"
    assert e.commits[0] == 1
    assert e.started == [(jid, "stanley", {"sex": "female", "name": "Miška", "history": []})]
    assert e.get(jid).json()["state"] == "queued"


def test_owner_is_private_and_owner_field_never_leaves():
    e = Env()
    jid = e.post().json()["jobId"]
    assert e.get(jid, token="tok-m").status_code == 404
    assert "owner" not in e.get(jid).json()


def test_validation():
    e = Env()
    assert e.post(q="sex=x").status_code == 400
    assert e.post(q="history=%7Bbad").status_code == 400
    assert e.post(q="history=%7B%7D").status_code == 400
    assert e.post(q="name=" + "a" * 61).status_code == 400
    assert e.post(b"").status_code == 400
    assert list(e.path.iterdir()) == [] and e.started == []


def test_history_is_capped_to_five():
    e = Env()
    h = json.dumps([{"score": i} for i in range(9)])
    import urllib.parse as u
    e.post(q="sex=male&history=" + u.quote(h))
    assert [x["score"] for x in e.started[0][2]["history"]] == [4, 5, 6, 7, 8]


def test_too_big_by_header_and_by_stream():
    e = Env()
    r = e.client.post("/jobs", content=b"x", headers={"Authorization": "Bearer tok-s", "Content-Length": str(A.MAX_UPLOAD + 1)})
    assert r.status_code == 413 and "300 MB" in r.json()["detail"]
    old, A.MAX_UPLOAD = A.MAX_UPLOAD, 3
    try:
        def gen():
            yield b"aa"
            yield b"bb"
        r = e.client.post("/jobs", content=gen(), headers={"Authorization": "Bearer tok-s"})
    finally:
        A.MAX_UPLOAD = old
    assert r.status_code == 413
    assert list(e.path.iterdir()) == [], "partial upload must be removed"


def test_spawn_failure_removes_clip_and_reports():
    e = Env(start_fails=True)
    r = e.post()
    assert r.status_code == 503
    assert list(e.path.iterdir()) == []
    assert [v["state"] for k, v in e.jobs.items() if k.startswith("job:")] == ["error"]


def test_stale_job_becomes_error_but_done_does_not():
    e = Env()
    jid = e.post().json()["jobId"]
    e.t[0] += A.STALE_S + 1
    j = e.get(jid).json()
    assert j["state"] == "error" and "prerušila" in j["error"]
    k = A.job_key("d")
    e.jobs.put(k, {"state": "done", "owner": "stanley", "updatedAt": 0, "result": {"N": 1}})
    assert e.get("d").json()["state"] == "done"


def test_poll_is_recorded_for_push_decision():
    e = Env()
    jid = e.post().json()["jobId"]
    e.get(jid)
    assert e.jobs[A.poll_key(jid)] == e.t[0]


def test_warm_never_fails_the_caller():
    e = Env()
    assert e.client.post("/warm", headers={"Authorization": "Bearer tok-s"}).json() == {"ok": True}
    assert e.warmed == [1]


def test_push_subscribe_dedupes_and_validates():
    e = Env()
    h = {"Authorization": "Bearer tok-s"}
    sub = {"endpoint": "https://web.push.apple.com/x", "keys": {"p256dh": "a", "auth": "b"}, "expirationTime": None}
    assert e.client.post("/push/subscribe", json=sub, headers=h).status_code == 200
    assert e.client.post("/push/subscribe", json=sub, headers=h).status_code == 200
    assert len(e.jobs[A.subs_key("stanley")]) == 1
    assert e.client.post("/push/subscribe", json={"endpoint": "http://x", "keys": {}}, headers=h).status_code == 400
    assert e.client.get("/push/key", headers=h).json() == {"publicKey": "PUB"}


def test_cors_allows_authorization_preflight():
    e = Env()
    r = e.client.options("/jobs", headers={"Origin": "https://x.github.io", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization"})
    assert r.status_code == 200


# ---------- worker ----------
class FakeDaemon:
    def __init__(self, write=None, fail=None, result=None, during=None):
        self.write, self.fail, self.result, self.during, self.up, self.stopped, self.ran = write, fail, result, during, True, 0, []
    def alive(self):
        return self.up
    def start(self):
        self.up = True
    def stop(self):
        self.up = False
        self.stopped += 1
    def run(self, job, on_progress=None, on_result=None):
        self.ran.append(job)
        if on_progress:
            on_progress({"stage": "Tracking pose", "done": 2, "total": 4})
        if self.result is not None:
            on_result({"result": self.result, "coachFallback": {"source": "template"}})
            if self.during:
                self.during()
        if self.fail:
            raise self.fail
        Path(job["out"]).write_text(json.dumps(self.write))
        return {"done": True}


def run_job(daemon, clip=True, push=None, polled=None, token=None, jobs=None):
    d = tempfile.TemporaryDirectory()
    p = Path(d.name)
    jobs, commits = (jobs if jobs is not None else Store()), [0]
    jobs.put(A.job_key("j"), {"state": "queued", "owner": "s", "updatedAt": 1})
    if polled is not None:
        jobs.put(A.poll_key("j"), polled)
    if clip:
        (p / "j").write_bytes(b"c")
    def commit():
        commits[0] += 1
    out = W.process_job("j", "s", {"sex": "male", "name": "S", "history": []}, jobs=jobs, clips_dir=p, reload_clips=lambda: None,
                        commit_clips=commit, daemon=daemon, push=push, claude_token=token, tmp=d.name, now=lambda: 100.0)
    return out, jobs[A.job_key("j")], list(p.iterdir()), commits[0], d


def test_job_success_stores_result_and_deletes_clip():
    pushes = []
    o, rec, left, commits, _d = run_job(FakeDaemon({"result": {"N": 3}, "coach": {"source": "template"}}), push=lambda *a: pushes.append(a))
    assert o["state"] == "done" and rec["result"] == {"N": 3} and rec["coach"]["source"] == "template"
    assert left == [] and commits == 1
    assert pushes == [("s", "j", True)]


def test_job_error_message_from_analysis_is_kept():
    o, rec, left, _, _d = run_job(FakeDaemon({"error": "Vo videu som nenašiel skokana."}))
    assert o == {"state": "error", "error": "Vo videu som nenašiel skokana."} and left == []


def test_job_crash_deletes_clip_with_generic_slovak_error():
    pushes = []
    o, rec, left, _, _d = run_job(FakeDaemon(fail=RuntimeError("Tensor size mismatch")), push=lambda *a: pushes.append(a))
    assert rec["error"] == W.FAILED and "Tensor" not in rec["error"] and left == []
    assert pushes == [("s", "j", False)]


def test_job_timeout_restarts_the_node_process():
    d = FakeDaemon(fail=TimeoutError("hung"))
    o, *_ , = run_job(d)
    assert o["state"] == "error" and d.stopped == 1


def test_missing_clip_reported():
    o, *_ = run_job(FakeDaemon({"result": {}}), clip=False)
    assert o["error"] == W.NO_CLIP


def test_no_push_while_the_app_is_watching():
    pushes = []
    run_job(FakeDaemon({"result": {"N": 1}}), push=lambda *a: pushes.append(a), polled=98.0)
    assert pushes == []
    run_job(FakeDaemon({"result": {"N": 1}}), push=lambda *a: pushes.append(a), polled=50.0)
    assert len(pushes) == 1


def test_push_failure_does_not_change_the_outcome():
    def boom(*a):
        raise RuntimeError("apns down")
    o, rec, *_ = run_job(FakeDaemon({"result": {"N": 1}}), push=boom)
    assert rec["state"] == "done"


def test_result_is_visible_before_coaching_finishes():
    jobs, seen = Store(), {}
    def during():
        seen.update(jobs[A.job_key("j")])
    o, rec, left, *_ = run_job(FakeDaemon({"result": {"N": 9}, "coach": {"source": "claude"}}, result={"N": 9}, during=during), jobs=jobs)
    assert seen["state"] == "running" and seen["stage"] == "coach" and seen["result"] == {"N": 9}
    assert "coach" not in seen
    assert rec["state"] == "done" and rec["coach"]["source"] == "claude" and rec["result"] == {"N": 9} and left == []


def test_coaching_crash_keeps_the_result_and_uses_the_fallback():
    for fail in (RuntimeError("analysis process exited"), TimeoutError("hung")):
        pushes = []
        o, rec, left, *_ = run_job(FakeDaemon(fail=fail, result={"N": 9}), push=lambda *a: pushes.append(a))
        assert rec["state"] == "done" and rec["result"] == {"N": 9} and rec["coach"] == {"source": "template"}
        assert left == [] and pushes == [("s", "j", True)]


def test_claude_token_reaches_only_the_node_job():
    d = FakeDaemon({"result": {"N": 1}}, result={"N": 1})
    o, rec, *_ = run_job(d, token="fake-secret-token")
    assert d.ran[0]["claudeToken"] == "fake-secret-token"
    assert "fake-secret-token" not in json.dumps(rec) and "fake-secret-token" not in json.dumps(o)
    d2 = FakeDaemon({"result": {"N": 1}})
    run_job(d2)
    assert "claudeToken" not in d2.ran[0]


def test_token_lookup_is_per_person_and_never_raises():
    raw = json.dumps({"stanley": "ts", "miska": ""})
    assert W.claude_token_for("stanley", raw) == "ts"
    assert W.claude_token_for("miska", raw) is None, "no token means no token, not someone else's"
    assert W.claude_token_for("nobody", raw) is None
    assert W.claude_token_for("stanley", "{not json") is None
    assert W.claude_token_for("stanley", None) is None
    assert W.claude_token_for("stanley", "[1]") is None


def test_token_map_is_hidden_from_the_node_process():
    import os
    os.environ.update(JUMP_CLAUDE_TOKENS="{}", VAPID_PRIVATE="x", KEEP_ME="1")
    try:
        env = W.daemon_env()
    finally:
        del os.environ["JUMP_CLAUDE_TOKENS"], os.environ["VAPID_PRIVATE"], os.environ["KEEP_ME"]
    assert "JUMP_CLAUDE_TOKENS" not in env and "VAPID_PRIVATE" not in env and env["KEEP_ME"] == "1"


def test_api_can_omit_a_result_the_client_has():
    e = Env()
    e.jobs.put(A.job_key("r"), {"state": "running", "stage": "coach", "owner": "stanley", "updatedAt": e.t[0], "result": {"N": 1}})
    assert e.get("r").json()["result"] == {"N": 1}
    r = e.client.get("/jobs/r?omit=result", headers={"Authorization": "Bearer tok-s"}).json()
    assert "result" not in r and r["stage"] == "coach"


def test_stale_job_with_a_result_ends_done():
    e = Env()
    e.jobs.put(A.job_key("r"), {"state": "running", "stage": "coach", "owner": "stanley", "updatedAt": 0, "result": {"N": 1}})
    e.t[0] = A.STALE_S + 5
    j = e.get("r").json()
    assert j["state"] == "done" and j["result"] == {"N": 1} and j["coach"] is None


NODE_STUB = """
import json, sys
print(json.dumps({"ready": True, "provider": "cuda"}), flush=True)
print("library noise on stdout", flush=True)
for line in sys.stdin:
    job = json.loads(line)
    if job.get("hang"):
        continue
    if job.get("die"):
        sys.exit(3)
    print(json.dumps({"id": job["id"], "progress": {"stage": "x", "done": 1, "total": 2}}), flush=True)
    print(json.dumps({"id": job["id"], "result": {"N": 2}, "coachFallback": None}), flush=True)
    if job.get("bad"):
        print(json.dumps({"id": job["id"], "error": "boom"}), flush=True)
    else:
        print(json.dumps({"id": job["id"], "done": True}), flush=True)
"""


def test_daemon_protocol_against_a_real_child_process():
    d = W.Daemon([sys.executable, "-c", NODE_STUB])
    assert d.start(timeout=10)["provider"] == "cuda"
    seen, results = [], []
    assert d.run({"a": 1}, on_progress=seen.append, on_result=results.append)["done"]
    assert seen == [{"stage": "x", "done": 1, "total": 2}]
    assert results[0]["result"] == {"N": 2}
    try:
        d.run({"bad": True})
        assert False
    except RuntimeError as e:
        assert str(e) == "boom"
    try:
        d.run({"hang": True}, stall=0.3)
        assert False
    except TimeoutError:
        pass
    d.restart()
    try:
        d.run({"die": True}, stall=5)
        assert False
    except RuntimeError as e:
        assert "exited" in str(e)
    assert not d.alive() or d.proc.wait(timeout=5) == 3
    d.stop()


def test_make_push_prunes_gone_subscriptions():
    from pywebpush import WebPushException
    import pywebpush
    sent = []
    class Resp:
        status_code = 410
    def fake(subscription_info, data, vapid_private_key, vapid_claims, ttl, headers):
        sent.append((subscription_info["endpoint"], json.loads(data)["title"]))
        if "gone" in subscription_info["endpoint"]:
            raise WebPushException("gone", response=Resp())
    real, pywebpush.webpush = pywebpush.webpush, fake
    try:
        jobs = Store()
        jobs.put(A.subs_key("s"), [{"endpoint": "https://a/live"}, {"endpoint": "https://a/gone"}])
        W.make_push(jobs, "key", "mailto:x@y.z")("s", "j", True)
    finally:
        pywebpush.webpush = real
    assert [s["endpoint"] for s in jobs[A.subs_key("s")]] == ["https://a/live"]
    assert sent[0][1] == "Analýza je hotová"
    assert W.make_push(Store(), "", "") is None


def test_real_vapid_signature_from_a_minted_style_key():
    """The key format server/mint.mjs prints is what py_vapid must accept."""
    from cryptography.hazmat.primitives.asymmetric import ec
    import base64
    from py_vapid import Vapid
    n = ec.generate_private_key(ec.SECP256R1()).private_numbers().private_value
    raw = base64.urlsafe_b64encode(n.to_bytes(32, "big")).rstrip(b"=").decode()
    v = Vapid.from_string(raw)
    assert "Authorization" in v.sign({"sub": "mailto:a@b.c", "aud": "https://web.push.apple.com", "exp": 9999999999})


def test_sweep_removes_only_old_files():
    d = tempfile.TemporaryDirectory()
    p = Path(d.name)
    (p / "old").write_bytes(b"x")
    (p / "new").write_bytes(b"x")
    import os
    os.utime(p / "old", (1000, 1000))
    commits = []
    assert W.sweep_clips(p, lambda: commits.append(1), max_age_s=3600, now=lambda: (p / "new").stat().st_mtime) == 1
    assert [f.name for f in p.iterdir()] == ["new"] and commits == [1]


def test_athletes_roster_goes_to_the_job():
    import urllib.parse as u
    e = Env()
    roster = [{"id": "stanley", "sex": "male", "name": "Stanley", "height": 186, "pb": 7.0, "history": [{"score": i} for i in range(8)]},
              {"id": "miska", "sex": "female", "name": "Miška", "height": 500}]
    assert e.post(q="sex=male&athletes=" + u.quote(json.dumps(roster))).status_code == 200
    got = e.started[0][2]["athletes"]
    assert [a["id"] for a in got] == ["stanley", "miska"]
    assert [h["score"] for h in got[0]["history"]] == [3, 4, 5, 6, 7]
    assert got[0]["height"] == 186 and "height" not in got[1]   # nonsense height dropped
    assert got[0]["pb"] == 7.0 and "pb" not in got[1]


def test_bad_athletes_roster_is_refused():
    import urllib.parse as u
    e = Env()
    for bad in ['{"id":"x"}', '[{"id":"x","sex":"other"}]', '[{"sex":"male"}]', "[1]", "nope"]:
        assert e.post(q="athletes=" + u.quote(bad)).status_code == 400


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok  ", name)
            except Exception as e:
                import traceback
                fails += 1
                print("FAIL", name)
                traceback.print_exc()
    sys.exit(1 if fails else 0)

