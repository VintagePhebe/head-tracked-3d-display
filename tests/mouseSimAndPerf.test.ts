import { describe, expect, it } from 'vitest';
import { PerfMonitor } from '../src/perf/perfMonitor';
import { v3 } from '../src/projection/offAxis';
import { MouseSimulator } from '../src/tracking/mouseSim';

describe('MouseSimulator', () => {
  it('starts at the default central viewing distance and interpolates toward target eye positions', () => {
    const sim = new MouseSimulator(0.6);
    const out = v3(0, 0, 0);
    sim.sample(1 / 60, 1, out);
    expect(out).toEqual(v3(0, 0, 0.6));

    sim.setEye(0.2, -0.1, 0.45, false);
    for (let i = 0; i < 60; i++) sim.sample(1 / 60, 1, out);
    expect(out.x).toBeCloseTo(0.2, 3);
    expect(out.y).toBeCloseTo(-0.1, 3);
    expect(out.z).toBeCloseTo(0.45, 3);
  });

  it('clamps viewing distance within [minZ, maxZ] and supports immediate jumps and reset', () => {
    const sim = new MouseSimulator(0.6);
    const out = v3(0, 0, 0);
    sim.setEye(-0.15, 0.05, 0.02, true);
    sim.sample(0, 1, out);
    expect(out.x).toBeCloseTo(-0.15, 6);
    expect(out.z).toBeCloseTo(sim.minZ, 6);

    sim.reset();
    for (let i = 0; i < 90; i++) sim.sample(1 / 60, 1, out);
    expect(out.x).toBeCloseTo(0, 3);
    expect(out.y).toBeCloseTo(0, 3);
    expect(out.z).toBeCloseTo(0.6, 3);
  });
});

describe('PerfMonitor', () => {
  it('computes FPS, average frame time, and p95 frame time over a window', () => {
    const p = new PerfMonitor();
    let t = 0;
    p.tick(t);
    for (let i = 0; i < 40; i++) {
      t += 10; // 100 FPS (10 ms per frame)
      p.tick(t);
    }
    expect(p.snapshot.fps).toBeCloseTo(100, 1);
    expect(p.snapshot.frameMs).toBeCloseTo(10, 1);
    expect(p.snapshot.p95FrameMs).toBeCloseTo(10, 1);
  });
});
