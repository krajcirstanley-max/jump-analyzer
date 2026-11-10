# Analysis server

A small web API in the EU takes the upload; a GPU container runs the same JS the phone runs
(`js/pose/*`, `js/analysis/*`). The numbers reach the phone first; the coaching follows.
Clips are deleted when the job ends.

## Deploy

Run everything from the repo root. `models/*.onnx` must be on this Mac: the deploy bakes them
into the image, so there is no separate model upload.

Steps 2-4 in one go, typed into your own terminal so no token passes through a chat:
`bash server/setup.sh YOUR_EMAIL`. It writes the phone codes to `server/.app-tokens.txt` (gitignored).

1. Create an account at modal.com and add a card.
2. Install the CLI and log in:
   ```
   pip install modal
   modal token new
   ```
3. Mint the app tokens and push keys. This prints two `modal secret create` commands; run both.
   Use your own email: Apple rejects push from a placeholder address.
   ```
   node server/mint.mjs mailto:YOUR_EMAIL stanley miska
   ```
4. Each person generates their own Claude token, logged in to their own Claude account.
   Anthropic requires each end user to use their own credentials, so nobody shares one:
   ```
   claude setup-token
   ```
   Then store them under the same names as step 3:
   ```
   modal secret create jump-claude JUMP_CLAUDE_TOKENS='{"stanley":"HIS_TOKEN","miska":"HER_TOKEN"}'
   ```
   Someone left out gets the API key below if there is one, otherwise template coaching. Never
   someone else's token. To add `ANTHROPIC_API_KEY=...`, put it on the same command. To change
   the secret later, repeat the command with `--force`; no redeploy is needed.
5. Deploy. The first build takes several minutes and uploads about 300 MB of models.
   ```
   modal deploy server/modal_app.py
   ```
   The output ends with a URL like `https://YOURNAME--jump-analyzer-web.modal.run`.
6. Confirm it is really on the GPU:
   ```
   modal run server/modal_app.py::Analyzer.warm
   ```
   The log prints `provider` and `msPerRun`. Expect `cuda` and `rtmw-l-384` well under 50 ms.
   A `WARNING ... looks like CPU` line means the GPU libraries did not load.
7. Put the URL in `js/config.js` (`CLOUD_URL`) and publish the site.
8. On each phone, paste that person's app token (the last block of step 3's output) into the app.
   Add the app to the Home Screen before turning on notifications; iOS allows push only there.

To check the API without the phone:
```
curl -X POST "$URL/jobs?sex=female&name=Miska" -H "Authorization: Bearer $TOKEN" \
  --data-binary @clip.mov -H 'Content-Type: application/octet-stream'
curl "$URL/jobs/JOB_ID" -H "Authorization: Bearer $TOKEN" | head -c 400
```

### If a step fails

- **Build stops after `ldd` and names a library:** the CUDA wheels in `modal_app.py` do not cover
  what onnxruntime-node needs. The build prints the missing `.so`; add the wheel that provides it.
- **Jobs stay queued:** H100 capacity in the EU may be short. `GPU = "L4"` in `modal_app.py` is the one-line switch.
- **Deploy rejects `routing_region`:** the plan may not allow it. Remove that line from `web()`.
  Uploads then enter through Virginia, which is slower from Slovakia but still works.
  `routing_region` can only be set on a function's first deploy.

## Cost

Modal list prices, checked 2026-11-09: H100 $0.001097/s, CPU $0.0000131/core/s, memory
$0.00000222/GiB/s, EU region multiplier 1.15. With 4 cores and 16 GiB that is about
$0.00136 per second the GPU container is up.

| Case | Container up (estimate) | Cost (estimate) |
|---|---|---|
| Single analysis after idle: cold start 15 s, pose 12 s, coaching 40 s, idle 60 s | ~130 s | ~$0.18 |
| Another analysis while the container is still warm | ~55 s more | ~$0.07 |

These times are estimates until measured after deploy. The numbers should appear about 15 s
after the upload ends on a warm container; coaching follows 20-60 s later. The web API costs well
under a tenth of a cent per job. Modal's Starter plan includes $30 of credit a month, roughly
170 single analyses. Subscription coaching draws on each person's own Claude usage; an API key,
if configured, is billed separately and is not in this table.

The H100 sits idle during the coaching call and for 60 s afterwards (`scaledown_window`), and
that waiting is most of the bill. The L4 is about a quarter of the price per second, and its pose
step should be only a few seconds slower, since decoding and JS preprocessing take much of it.

## How it fits together

| File | Role |
|---|---|
| `modal_app.py` | Images, secrets, GPU class, web function, hourly clip sweep |
| `api.py` | The HTTP API. No Modal imports; storage is injected |
| `worker.py` | Runs a job, drives the Node process, sends the push |
| `analyze.mjs` | Pose, `analyzeJump`, snapshots, coaching. CLI or `--serve` |
| `frames.mjs` | One ffmpeg decode into RAM, or streaming if the clip exceeds the budget |
| `coach.mjs` | Coaching text |
| `claude-cli.mjs` | Coaching through a person's own subscription (`claude -p`) |
| `mint.mjs` | Prints the secrets commands |

Endpoints beyond the contract, all backward compatible: `POST /warm`, `GET /push/key`,
`POST /push/subscribe`, `GET /health`.

Memory snapshots are off (`SNAPSHOT = False` in `modal_app.py`). GPU snapshots are alpha and
Modal does not document whether they capture a child process, which is where the models live.
The warm-up sent with the upload hides most of the cold start anyway. To try them, set it to
`True` and redeploy; the container health-checks the restored process and starts a fresh one
if needed.

## Tests

```
npm --prefix server ci
node --test tests/server.test.mjs
python server/test_api.py        # needs: pip install fastapi httpx pywebpush
```

Run one clip through the whole path on a Mac CPU (add `COACH_VIA=subscription` in front to use this Mac's own Claude login; that switch is for local runs only):
```
node server/analyze.mjs tests/real/IMG_4390.MOV /tmp/out.json --sex female --name Miška
```
