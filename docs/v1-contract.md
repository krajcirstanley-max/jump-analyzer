# v1 build contract

Shared by the agents building v1 in parallel. If you need to change anything here, keep the change backward compatible and say so in your final report.

Benchmark and feature list: `~/Documents/Vault/60 App Builds/Jump Video Analyzer - feature plan.md`, sections "What it really does" and "Feature list v1".

## Rules for everyone

- Vanilla ES modules, no build step, no framework. Match the surrounding code: short comments that say why, terse names.
- Edit only the files your brief owns. Other agents are editing the rest right now. Need something from another owner's file? Code against this contract.
- `npm test` can be red because of someone else's half-finished file. Run only your own test files (`node --test tests/x.test.mjs`).
- Never commit, push or deploy. Never `git add`. `tests/real/` clips carry GPS and stay local.
- All text the athlete reads is **Slovak**, with correct diacritics. Slovak coaching cues are quoted verbatim, never translated.
- Never use the words "AI" or a brand name in the UI for the analysis. Do not copy athleticsai.app's name, copy or visual design. Same information, our own look (the existing dark theme in `css/app.css`).
- Test clips: `tests/real/IMG_2674.MOV` (Stanley, outdoor, 120 fps, landing visible), `tests/real/IMG_4390.MOV` (Miška, indoor, pillars, landing hidden). Saved pose results: `tests/fixtures/_real_IMG_2674_pose.json`, `tests/fixtures/_real_IMG_4390_pose.json`.
- Key frames, already verified at high zoom. IMG_2674: td3 678, penTD 714, penTO 727, TD 735, maxFlex 744, TO 752, apex 785, landing 838. IMG_4390: td3 421, penTD 454, penTO 469, TD 483, maxFlex 490, TO 497, apex 530, no landing. Do not change `events.js` detection.

## Data: `analyzeJump(result, sex, ts)`

Moves from `js/analysis/view.js` to a new DOM-free `js/analysis/jump.js`, importable in Node. Returns the current fields (`...ev, dir, fps, flight, metrics, score, coach`) plus:

```js
phases: [{
  id: 'pen' | 'plant' | 'toeoff' | 'flight' | 'landing',
  label: 'Predposledný' | 'Plant' | 'Odraz' | 'Let' | 'Dopad',
  weight, score /* 0-100 or null */,
  from, to,            // frame range of the phase, consecutive, for the timeline bands
  frame,               // the frame a tile jumps to
  keyFrames: [{ id, label, frame }],
  metrics: [Metric],   // only this phase's rows, in display order
}],
speed: { last: Metric|null, takeoff: Metric|null, loss: Metric|null, lossPct: number|null, sure: 'vysoká'|'stredná'|'nízka', note: string },
replay: { from, to },  // 1 s before takeoff touchdown to 0.5 s after landing, or clip end when landing is hidden
```

`Metric` keeps today's fields (`key, label, unit, value, norm, status, frame, yaw, reason, estimate, good`) and adds `score` (0-100, null if hidden) and `target` (the nearest value inside `norm`, equal to `value` when in range).

| Phase | weight | Metric keys, display order | Key frames |
|---|---|---|---|
| pen | .20 | contactPen, flightToBoard, hipDrop, penKnee | td3, penTD, penTO |
| plant | .35 | contactTO, kneeTD, legTD, inclTD, kneeMin | TD, maxFlex |
| toeoff | .25 | kneeTO, hipTO, takeoffAngle, kneeDrive, trunkTO | TO |
| flight | .05 | flight, peakHeight, trunkStability | apex |
| landing | .15 | landingReach, kneeLand, hipLand, estDistance | landing |

Every other metric (trunkTD, flexion, braking, propulsion, inclTO, thighTO, vyTO, speedTD) stays in `metrics` and appears only under "všetky čísla". Metric labels in `NORMS` become Slovak.

New metric keys: `hipDrop` (cm), `penKnee` (°, extra stance-knee bend in the penultimate), `peakHeight` (cm), `trunkStability` (°), `kneeDrive` (°), `speedLast` (m/s), `speedTO` (m/s).

## Coaching object: `jump.coach`

```js
{
  source: 'claude' | 'template',
  take: string,            // one sentence, addresses the athlete by name
  strength: string|null,
  fixes: [{                // at most 3, most costly first; fixes[0] is the one runway cue
    title: string, body: string, phase: PhaseId, metricKey: string|null,
    cue: string|null,      // verbatim from the Coaching SOP's approved list
    why: string,
  }],
  nextCue: string|null,    // fixes[0].cue
}
```


## Player additions (`js/player.js`)

`setRange(from, to)` limits scrubber, stepping and playback. `setLoop(bool)`. `setBands([{ from, to, id, on }])` colours the timeline by phase. `show(i)`, `pause()`, `play()`, `ts`, `overlays`, `onFrame`, `refresh()`, `dispose()` stay.

Removed: Set 0 / `setZero`, ±10 buttons, jog drag, 1/8 and 1/4 speeds. Speeds left: real and 0.5×.

## Overlays

- `js/analysis/labels.js`: `jointLabels(jump, result, scale)` returns an overlay `(ctx, toCanvas, index)`. Replaces `angleOverlay`.
- `js/pose/occlusion.js`: `hiddenFrames(result)` returns a `Set` of frames where the athlete is covered. `skeletonOverlay` draws those frames dimmed.

## Cloud client: `js/cloud.js`

```js
cloudReady(): boolean                       // URL and token both set
getCloudToken(), setCloudToken(s)           // localStorage, wrapped in try/catch
analyzeInCloud(file, { sex, name, history, onProgress, onResult, signal }): Promise<{ result, coach, ms }>
resumeCloudJob(jobId, { onProgress, onResult, signal }): Promise<{ result, coach, ms }>
pendingCloudJob(jobId?): { jobId, at } | null // that job if still pending; with no id, the newest
pendingCloudJobs(): [{ jobId, at }]         // every pending job, oldest first
enableNotifications(): Promise<boolean>
```

`result` has exactly the shape of the worker's `result` (`js/pose/worker.js`, `runPipeline`), so `analyzeJump` runs on it unchanged. `onProgress({ stage, done, total })` matches the worker, with `stage` already in Slovak. `onResult({ result, ms })` is called once, as soon as the numbers exist; the promise resolves later, when the coaching is in. `coach` can be `null` when analysis found no jump. When `cloudReady()` is false the app falls back to the local worker. `history` is at most the last 5 attempts as `{ date, score, phases, metrics: { key: value } }`.

## Server API (`server/`, Modal, region eu)

- `POST /jobs`, header `Authorization: Bearer <token>`, body = the clip bytes, query `sex`, `name`, `history` (URI-encoded JSON). Returns `{ jobId }`.
- `GET /jobs/{id}`, same auth. Returns `{ state: 'queued'|'running'|'done'|'error', stage, done, total, result?, coach?, error? }`. `result` appears as soon as pose and analysis are done, while `state` is still `'running'` and `stage` is `'coach'`; `coach` arrives with `state: 'done'`. Once `result` exists the job ends `done`, never `error`: a failed coaching step yields the template coach. Optional query `omit=result` leaves the result out of the response, for clients that already have it.
- The clip is deleted as soon as the job ends, success or failure.
- `server/analyze.mjs <clip> <out.json> --sex male|female --name <n> [--history file]` is the single entry point: pose, then `analyzeJump`, then coaching. The result is emitted before the coaching call starts. It reuses `js/pose/*` and `js/analysis/*` unchanged, so phone and server can never disagree.
- Coaching is paid for by, in order: the app user's own `CLAUDE_CODE_OAUTH_TOKEN` (from the Modal Secret, never another person's), `ANTHROPIC_API_KEY` if configured, otherwise the template. `COACH_VIA=subscription` applies to local one-shot runs only.
- `server/coach.mjs` exports `writeCoaching({ jump, snapshots, name, sex, history, apiKey, client }): Promise<coach>`, where `snapshots` is an array of 5 `{ phase, jpeg: Buffer }`. It falls back to the template coach on any failure.
