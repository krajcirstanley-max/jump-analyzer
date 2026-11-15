"""The training video's job on the render container: the story and clips the app uploaded become one
MP4 next to them in the clips volume. Inputs go as soon as it is drawn; the video goes with the hourly
sweep (worker.sweep_clips), after the app has fetched it."""
import json
import time
from pathlib import Path


def pick_music(music_dir, story, rid):
    """one track from the library; the app may ask for one by number (it changes it day by day)"""
    try:
        names = json.load(open(Path(music_dir) / "index.json"))
    except (OSError, ValueError):
        names = sorted(p.stem for p in Path(music_dir).glob("*.wav")) if Path(music_dir).is_dir() else []
    names = [n for n in names if (Path(music_dir) / f"{n}.wav").exists()]
    if not names:
        return None
    k = story.get("music")
    k = k if isinstance(k, int) else sum(map(ord, rid))
    return str(Path(music_dir) / f"{names[k % len(names)]}.wav")


def process_recap(rid, owner, *, jobs, clips_dir, reload_clips, commit_clips, music_dir, render=None, now=time.time):
    from recap_render import render as draw
    render = render or draw
    key = f"recap:{rid}"
    reload_clips()
    clips_dir = Path(clips_dir)
    story_path = clips_dir / f"recap-{rid}.json"
    job = jobs.get(key) or {}
    jobs.put(key, {**job, "state": "running", "updatedAt": now()})
    try:
        story = json.loads(story_path.read_text())
        paths = [str(clips_dir / f"recap-{rid}-c{k}") for k in range(len(story["clips"]))]
        out = clips_dir / f"recap-{rid}.mp4"
        track = pick_music(music_dir, story, rid)
        print("recap", rid[:6], "clips", len(paths), "music", track)
        info = render(str(story_path), str(out), paths, music=track)
        drop(story_path, clips_dir, rid)
        commit_clips()   # the video on the volume before anyone is told it is there
        jobs.put(key, {**job, "state": "done", "seconds": info.get("seconds"), "updatedAt": now()})
    except Exception as e:
        print("recap failed:", repr(e))
        drop(story_path, clips_dir, rid)
        commit_clips()
        jobs.put(key, {**job, "state": "error", "error": "Video sa nepodarilo vyrobiť. Skús to znova.", "updatedAt": now()})


def drop(story_path, clips_dir, rid):
    for p in [story_path, *Path(clips_dir).glob(f"recap-{rid}-c*")]:
        Path(p).unlink(missing_ok=True)
