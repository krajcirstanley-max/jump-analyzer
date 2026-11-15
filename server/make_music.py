# One-off: the music library for "Video z tréningu". MusicGen (stereo large, weights CC-BY-NC: the
# videos are private) on an H100 writes ~55 s instrumentals into the jump-music volume, which the
# render function reads. 30 s first, then continued from its last 10 s, joined with a short crossfade.
#   modal run server/make_music.py
import modal

app = modal.App("jump-music-maker")
image = modal.Image.debian_slim(python_version="3.11").pip_install("torch==2.5.1", "transformers==4.46.3", "scipy", "accelerate", "numpy<2")
music = modal.Volume.from_name("jump-music", create_if_missing=True)

TRACKS = [
    ("trailer", "epic cinematic sports trailer, driving punchy drums, deep pulsing synth bass, rising strings, building energy, 120 bpm, instrumental"),
    ("electro", "dark energetic electronic sports montage, four on the floor kick, gritty synth bass, tension builds to a drop, 124 bpm, instrumental"),
    ("drums", "powerful tribal percussion, big taiko drums and claps, motivational sports intro, 118 bpm, instrumental"),
    ("hiphop", "hard hitting hip hop beat for a workout montage, heavy 808 bass, crisp snares, confident mood, 92 bpm, instrumental"),
    ("rock", "anthemic stadium rock instrumental, distorted guitars, big drums, triumphant sports highlight, 128 bpm"),
    ("synthwave", "modern cinematic synthwave, pulsing arpeggios, punchy drums, heroic night training mood, 110 bpm, instrumental"),
]


@app.function(gpu="H100", image=image, timeout=1800, memory=32768, volumes={"/music": music})
def make(names: list[str] | None = None, seed: int = 7) -> list[str]:
    import json, numpy as np, torch, scipy.io.wavfile as wav
    from transformers import AutoProcessor, MusicgenForConditionalGeneration
    name = "facebook/musicgen-stereo-large"
    proc = AutoProcessor.from_pretrained(name)
    model = MusicgenForConditionalGeneration.from_pretrained(name).to("cuda")
    sr = model.config.audio_encoder.sampling_rate
    done = []
    for k, (tag, prompt) in enumerate(TRACKS):
        if names and tag not in names:
            continue
        torch.manual_seed(seed + k)
        inp = proc(text=[prompt], padding=True, return_tensors="pt").to("cuda")
        a = model.generate(**inp, max_new_tokens=1500, do_sample=True, guidance_scale=3.0)[0].float().cpu().numpy()
        tail = a[:, -10 * sr:]
        inp2 = proc(text=[prompt], audio=[tail], sampling_rate=sr, padding=True, return_tensors="pt").to("cuda")
        b = model.generate(**inp2, max_new_tokens=1250, do_sample=True, guidance_scale=3.0)[0].float().cpu().numpy()
        b = b[:, tail.shape[1]:] if b.shape[1] > tail.shape[1] + sr else b
        x = int(0.5 * sr); fade = np.linspace(0, 1, x)
        out = np.concatenate([a[:, :-x], a[:, -x:] * (1 - fade) + b[:, :x] * fade, b[:, x:]], axis=1)
        out = out / max(1e-6, np.abs(out).max()) * 0.9
        wav.write(f"/music/{tag}.wav", sr, (out.T * 32767).astype(np.int16))
        done.append(f"{tag}: {out.shape[1] / sr:.1f} s")
        print(done[-1], flush=True)
    json.dump([t for t, _ in TRACKS], open("/music/index.json", "w"))
    music.commit()
    return done


@app.local_entrypoint()
def main():
    print(make.remote())
