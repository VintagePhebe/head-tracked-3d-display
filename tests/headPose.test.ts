import { describe, expect, it } from 'vitest';
import { HeadPoseFilter } from '../src/tracking/headPose';
import { OneEuroFilter, oneEuroFromSettings } from '../src/tracking/oneEuro';
import { v3, type Vec3 } from '../src/projection/offAxis';

const DEFAULT_EYE = v3(0, 0, 0.6);
const filt = oneEuroFromSettings(0.5, 0.5);
const finite = (v: Vec3) => [v.x, v.y, v.z].every(Number.isFinite);

// Deterministic pseudo-random noise
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296) - 0.5;
}

describe('One Euro filter', () => {
  it('converges to a constant input', () => {
    const f = new OneEuroFilter(filt);
    let y = 0;
    for (let i = 0; i < 300; i++) y = f.filter(0.25, i / 30);
    expect(y).toBeCloseTo(0.25, 6);
  });

  it('reduces jitter on a stationary noisy signal', () => {
    const f = new OneEuroFilter(filt);
    const n = rng(1);
    let inVar = 0, outVar = 0;
    for (let i = 0; i < 600; i++) {
      const x = 0.1 + n() * 0.004;
      const y = f.filter(x, i / 30);
      if (i > 60) {
        inVar += (x - 0.1) ** 2;
        outVar += (y - 0.1) ** 2;
      }
    }
    expect(outVar).toBeLessThan(inVar * 0.25);
  });

  it('tracks fast motion with limited lag when responsiveness is high', () => {
    const fast = new OneEuroFilter(oneEuroFromSettings(0.5, 1));
    const slow = new OneEuroFilter(oneEuroFromSettings(0.5, 0));
    let ef = 0, es = 0;
    for (let i = 0; i <= 30; i++) {
      const t = i / 30;
      const x = 0.5 * t; // 0.5 m/s sweep
      ef = Math.abs(fast.filter(x, t) - x);
      es = Math.abs(slow.filter(x, t) - x);
    }
    expect(ef).toBeLessThan(es);
    expect(ef).toBeLessThan(0.02); // < 2 cm behind at 0.5 m/s
  });

  it('ignores duplicate timestamps', () => {
    const f = new OneEuroFilter(filt);
    f.filter(1, 0);
    expect(f.filter(5, 0)).toBe(1);
  });
});

describe('HeadPoseFilter', () => {
  const feed = (h: HeadPoseFilter, e: Vec3, t0: number, t1: number, step = 33) => {
    for (let t = t0; t <= t1; t += step) h.onMeasurement(e, t);
  };

  it('returns the default eye before any data', () => {
    const h = new HeadPoseFilter(DEFAULT_EYE, filt);
    const out = v3(0, 0, 0);
    expect(h.sample(0, out)).toBe('no-data');
    expect(out).toEqual(DEFAULT_EYE);
  });

  it('converges to a steady measured position', () => {
    const h = new HeadPoseFilter(DEFAULT_EYE, filt);
    const target = v3(0.1, -0.05, 0.5);
    feed(h, target, 0, 3000);
    const out = v3(0, 0, 0);
    expect(h.sample(3000, out)).toBe('tracking');
    expect(out.x).toBeCloseTo(0.1, 4);
    expect(out.y).toBeCloseTo(-0.05, 4);
    expect(out.z).toBeCloseTo(0.5, 4);
  });

  it('holds, then eases back to the default position on tracking loss', () => {
    const h = new HeadPoseFilter(DEFAULT_EYE, filt, { holdMs: 600, returnMs: 1200 });
    const target = v3(0.2, 0.1, 0.5);
    feed(h, target, 0, 2000);
    const out = v3(0, 0, 0);
    h.sample(2000, out);
    const held = { ...out };
    h.onNoFace(2033);
    expect(h.sample(2300, out)).toBe('holding');
    expect(out).toEqual(held);
    expect(h.sample(2033 + 600 + 600, out)).toBe('returning');
    expect(out.x).toBeLessThan(held.x);
    expect(out.x).toBeGreaterThan(0);
    expect(h.sample(5000, out)).toBe('lost');
    expect(out).toEqual(DEFAULT_EYE);
  });

  it('treats a stalled camera as a loss', () => {
    const h = new HeadPoseFilter(DEFAULT_EYE, filt, { staleMs: 400 });
    feed(h, v3(0.1, 0, 0.5), 0, 1000);
    const out = v3(0, 0, 0);
    expect(h.sample(1100, out)).toBe('tracking');
    expect(h.sample(1600, out)).toBe('holding');
  });

  it('recovers smoothly without snapping', () => {
    const h = new HeadPoseFilter(DEFAULT_EYE, filt, { recoverMs: 250 });
    const out = v3(0, 0, 0);
    feed(h, v3(0, 0, 0.6), 0, 1000);
    h.onNoFace(1033);
    h.sample(5000, out); // fully returned to default
    h.onMeasurement(v3(0.2, 0, 0.6), 5000);
    h.sample(5000, out);
    expect(out.x).toBeCloseTo(0, 6); // starts exactly where the view was
    h.sample(5100, out);
    expect(out.x).toBeGreaterThan(0);
    expect(out.x).toBeLessThan(0.2);
    feed(h, v3(0.2, 0, 0.6), 5033, 6000);
    h.sample(6000, out);
    expect(out.x).toBeCloseTo(0.2, 3);
  });

  it('prediction reduces lag on constant-velocity motion', () => {
    const run = (prediction: boolean) => {
      const h = new HeadPoseFilter(DEFAULT_EYE, filt, { prediction });
      const out = v3(0, 0, 0);
      let err = 0;
      for (let t = 0; t <= 2000; t += 33) {
        h.onMeasurement(v3(0.0003 * t - 0.3, 0, 0.6), t); // 0.3 m/s
        const now = t + 40; // 40 ms pipeline latency
        h.sample(now, out);
        if (t > 500) err = Math.abs(out.x - (0.0003 * now - 0.3));
      }
      return err;
    };
    expect(run(true)).toBeLessThan(run(false) * 0.6);
  });

  it('applies lateral gain and clamps the eye in front of the screen', () => {
    const h = new HeadPoseFilter(DEFAULT_EYE, filt, { gain: 2, minDistance: 0.08 });
    feed(h, v3(0.1, 0.05, 0.01), 0, 3000);
    const out = v3(0, 0, 0);
    h.sample(3000, out);
    expect(out.x).toBeCloseTo(0.2, 3);
    expect(out.y).toBeCloseTo(0.1, 3);
    expect(out.z).toBe(0.08);
  });

  it('never produces NaN under noisy, irregular input', () => {
    const h = new HeadPoseFilter(DEFAULT_EYE, filt);
    const n = rng(7);
    const out = v3(0, 0, 0);
    let t = 0;
    for (let i = 0; i < 2000; i++) {
      t += 5 + Math.abs(n()) * 80;
      if (n() > 0.3) h.onNoFace(t);
      else h.onMeasurement(v3(n() * 0.5, n() * 0.3, 0.6 + n() * 0.4), t);
      h.sample(t + n() * 20, out);
      expect(finite(out)).toBe(true);
    }
  });
});
