/*
 * The ball-finding math, in JavaScript.
 *
 * This is a line-for-line port of local_infer.py + the streak rules in
 * live_detect.py, so the phone makes exactly the same decisions the PC does.
 * It runs in the phone browser AND in Node (for the parity test), which is
 * why the odd wrapper at the top and bottom.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BallDetect = factory();
})(typeof self !== "undefined" ? self : this, function () {

  const MODEL_SIZE = 640;          // the brain always looks at a 640x640 picture
  const CONF_THRESHOLD = 0.40;     // the beep bar (v4 brain talks quietly)
  const IOU_THRESHOLD = 0.45;      // for merging overlapping guesses
  const MAX_BALL_FRAC = 0.15;      // a golf ball can't fill this much of the frame
  const CONSECUTIVE_FRAMES_NEEDED = 4;
  const SAME_SPOT_FACTOR = 2.5;    // "same spot" = within 2.5 box widths

  /* ---------- reading the brain's answer ---------- */

  // The brain outputs one big list: 8400 candidate boxes, 5 numbers each
  // (centre x, centre y, width, height, how sure). Laid out channel-first,
  // so number `c` of candidate `i` sits at data[c * anchors + i].
  function decode(data, origW, origH, confThreshold) {
    if (confThreshold === undefined) confThreshold = CONF_THRESHOLD;
    const anchors = data.length / 5;
    const cand = [];
    for (let i = 0; i < anchors; i++) {
      const conf = data[4 * anchors + i];
      if (conf < confThreshold) continue;
      cand.push({
        cx: data[i],
        cy: data[anchors + i],
        w: data[2 * anchors + i],
        h: data[3 * anchors + i],
        confidence: conf,
      });
    }
    cand.sort((a, b) => b.confidence - a.confidence);

    // Non-max suppression: drop guesses that sit on top of a better guess.
    const kept = [];
    for (const c of cand) {
      let overlaps = false;
      for (const k of kept) {
        if (boxIou(c, k) >= IOU_THRESHOLD) { overlaps = true; break; }
      }
      if (!overlaps) kept.push(c);
    }

    // Back to real picture coordinates (the frame was squashed to 640x640).
    const sx = origW / MODEL_SIZE, sy = origH / MODEL_SIZE;
    const maxSize = MAX_BALL_FRAC * Math.min(origW, origH);
    const preds = [];
    for (const k of kept) {
      const width = k.w * sx, height = k.h * sy;
      if (width > maxSize || height > maxSize) continue;  // too big to be a ball
      preds.push({
        x: k.cx * sx, y: k.cy * sy,
        width: width, height: height,
        confidence: k.confidence,
        class: "ball",
      });
    }
    return preds;  // already sorted best-first
  }

  function boxIou(a, b) {
    const ax1 = a.cx - a.w / 2, ay1 = a.cy - a.h / 2;
    const ax2 = a.cx + a.w / 2, ay2 = a.cy + a.h / 2;
    const bx1 = b.cx - b.w / 2, by1 = b.cy - b.h / 2;
    const bx2 = b.cx + b.w / 2, by2 = b.cy + b.h / 2;
    const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
    const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
    const inter = ix * iy;
    const union = a.w * a.h + b.w * b.h - inter;
    return union ? inter / union : 0;
  }

  /* ---------- the "is it really a ball" rule ---------- */

  // Four frames in a row, and the ball has to stay in roughly the SAME SPOT.
  // Real balls hold still; noise jumps around the picture.
  class Streak {
    constructor() { this.count = 0; this.spot = null; }

    update(preds) {
      if (!preds.length) {
        this.count = 0;
        this.spot = null;
        return { streak: 0, hot: false, best: null };
      }
      const p = preds[0];
      let close = false;
      if (this.spot) {
        const [rx, ry, rw] = this.spot;
        close = Math.abs(p.x - rx) < rw * SAME_SPOT_FACTOR &&
                Math.abs(p.y - ry) < rw * SAME_SPOT_FACTOR;
      }
      this.count = close ? this.count + 1 : 1;
      this.spot = [p.x, p.y, Math.max(p.width, 20)];
      return {
        streak: this.count,
        hot: this.count >= CONSECUTIVE_FRAMES_NEEDED,
        best: p,
      };
    }
  }

  return {
    MODEL_SIZE, CONF_THRESHOLD, IOU_THRESHOLD, MAX_BALL_FRAC,
    CONSECUTIVE_FRAMES_NEEDED, SAME_SPOT_FACTOR,
    decode, Streak,
  };
});
