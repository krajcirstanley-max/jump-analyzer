# The camera's own motion between frames, for the sprint's toe-against-track rule (2026-11-22).
# The track beside the feet (sprint.mjs strips) is one flat red colour when the runner comes
# straight at the phone: its match jumped by 10-18 px a frame while the phone panned a steady 8,
# and 16 of 17 Freelap stretches of that day lost most of their steps. Here: corners all over the
# frame outside the runner (lamps, lane marks, wall, cones) followed with pyramidal Lucas-Kanade,
# kept only when they track back to where they started, the median of their motion. Those in the
# band of rows at the feet (the track at the runner's depth) are preferred when there are enough.
# On the 17 side-on clips read by hand this matched the strips (120 fps edges within a frame
# 96 %) and found more steps; at 60 fps touchdowns went from 90 to 99 %.
#
# stdin: {"path": raw RGBA frames, "W", "H", "from", "to", "boxes": {f: [x0, y0, x1, y1, footY]}}
# stdout: [[f, [dx, dy] all, [dx, dy] band or null, n], ...] in full-resolution px, frame f -> f+1.
import sys, json
import numpy as np
import cv2

SC = 0.5   # half resolution: 3.5 s for a 427-frame clip on a laptop, the median still sub-pixel


def main():
    cv2.setNumThreads(1)   # several of these run side by side, beside the toe threads
    q = json.load(sys.stdin)
    W, H, a, b = q["W"], q["H"], q["from"], q["to"]
    boxes = {int(k): v for k, v in q["boxes"].items()}
    size = W * H * 4
    raw = np.memmap(q["path"], dtype=np.uint8, mode="r")
    w, h = int(W * SC), int(H * SC)

    def grey(f):
        if (f + 1) * size > raw.size:
            return None
        img = np.asarray(raw[f * size:(f + 1) * size]).reshape(H, W, 4)
        return cv2.resize(cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY), (w, h), interpolation=cv2.INTER_AREA)

    out = []
    prev = grey(a)
    for f in range(a, b):
        cur = grey(f + 1)
        if prev is None or cur is None:
            break
        bx = boxes.get(f)
        mask = np.full((h, w), 255, np.uint8)
        if bx:
            x0, y0, x1, y1 = (v * SC for v in bx[:4])
            pad = 0.15 * (y1 - y0)
            mask[int(max(0, y0 - pad)):int(min(h, y1 + pad)), int(max(0, x0 - pad)):int(min(w, x1 + pad))] = 0
        pts = cv2.goodFeaturesToTrack(prev, 400, 0.01, 8, mask=mask)
        rec = None
        if pts is not None and len(pts) >= 8:
            nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, pts, None, winSize=(21, 21), maxLevel=3)
            ok = st.ravel() == 1
            p0, p1 = pts.reshape(-1, 2)[ok], nxt.reshape(-1, 2)[ok]
            if len(p0) >= 6:
                back, st2, _ = cv2.calcOpticalFlowPyrLK(cur, prev, p1.reshape(-1, 1, 2), None, winSize=(21, 21), maxLevel=3)
                good = (st2.ravel() == 1) & (np.linalg.norm(back.reshape(-1, 2) - p0, axis=1) < 0.5)
                p0, p1 = p0[good], p1[good]
            if len(p0) >= 6:
                d = (p1 - p0) / SC
                allm = np.median(d, axis=0)
                band = None
                if bx:
                    sel = np.abs(p0[:, 1] - bx[4] * SC) < 0.12 * h
                    if sel.sum() >= 5:
                        band = [round(float(v), 3) for v in np.median(d[sel], axis=0)]
                rec = [f, [round(float(v), 3) for v in allm], band, int(len(p0))]
        if rec:
            out.append(rec)
        prev = cur
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
