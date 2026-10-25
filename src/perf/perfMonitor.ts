/**
 * Lightweight zero-allocation frame timing and rendering statistics tracker.
 */
export interface PerfSnapshot {
  fps: number;
  frameMs: number;
  p95FrameMs: number;
}

const RING_SIZE = 120;

export class PerfMonitor {
  private ring = new Float32Array(RING_SIZE);
  private sorted = new Float32Array(RING_SIZE);
  private idx = 0;
  private filled = 0;
  private lastT = -1;
  private accumMs = 0;
  private accumFrames = 0;

  snapshot: PerfSnapshot = { fps: 0, frameMs: 0, p95FrameMs: 0 };

  /** Call once per rendered frame with `performance.now()`. Returns frame dt in seconds. */
  tick(nowMs: number): number {
    if (this.lastT < 0) {
      this.lastT = nowMs;
      return 1 / 60;
    }
    const dtMs = nowMs - this.lastT;
    this.lastT = nowMs;
    this.ring[this.idx] = dtMs;
    this.idx = (this.idx + 1) % RING_SIZE;
    if (this.filled < RING_SIZE) this.filled++;

    this.accumMs += dtMs;
    this.accumFrames++;
    if (this.accumMs >= 250) {
      const avgMs = this.accumMs / this.accumFrames;
      this.snapshot.frameMs = avgMs;
      this.snapshot.fps = avgMs > 0 ? 1000 / avgMs : 0;
      this.accumMs = 0;
      this.accumFrames = 0;
      if (this.filled > 0) {
        for (let i = 0; i < this.filled; i++) this.sorted[i] = this.ring[i];
        const sub = this.sorted.subarray(0, this.filled);
        sub.sort();
        this.snapshot.p95FrameMs = sub[Math.min(this.filled - 1, Math.floor(this.filled * 0.95))];
      }
    }
    return dtMs / 1000;
  }
}
