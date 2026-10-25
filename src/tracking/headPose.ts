/**
 * Head pose state machine: turns irregular, latent eye measurements (~30 Hz) into a smooth
 * eye position sampled every rendered frame (60+ Hz).
 *
 *  - One Euro smoothing per axis (depth smoothed a little more: it is the noisiest axis).
 *  - Optional latency compensation: linear extrapolation from the capture time to "now"
 *    using the filtered velocity, clamped to a short horizon.
 *  - Tracking loss: hold the last pose briefly, then ease back to the default viewing
 *    position. Recovery blends from the displayed pose to the tracked pose (no snapping).
 */
import type { Vec3 } from '../projection/offAxis';
import { OneEuroFilter, type OneEuroParams } from './oneEuro';

export type PoseState = 'no-data' | 'tracking' | 'holding' | 'returning' | 'lost';

export interface HeadPoseParams {
  holdMs: number;
  returnMs: number;
  recoverMs: number;
  /** No processed frame for this long while "tracking" = treat as lost (camera stall). */
  staleMs: number;
  maxPredictMs: number;
  prediction: boolean;
  /** Lateral gain (1 = physically correct). */
  gain: number;
  /** Eyes are never allowed closer than this to the screen plane (metres). */
  minDistance: number;
}

export const DEFAULT_POSE_PARAMS: HeadPoseParams = {
  holdMs: 600,
  returnMs: 1200,
  recoverMs: 250,
  staleMs: 400,
  maxPredictMs: 60,
  prediction: true,
  gain: 1,
  minDistance: 0.08,
};

const Z_SMOOTHING_FACTOR = 0.7; // depth cutoff multiplier

const smoothstep = (k: number) => {
  const c = Math.min(1, Math.max(0, k));
  return c * c * (3 - 2 * c);
};
const lerpInto = (out: Vec3, a: Vec3, b: Vec3, k: number) => {
  out.x = a.x + (b.x - a.x) * k;
  out.y = a.y + (b.y - a.y) * k;
  out.z = a.z + (b.z - a.z) * k;
  return out;
};
const copyInto = (out: Vec3, a: Vec3) => ((out.x = a.x), (out.y = a.y), (out.z = a.z), out);

export class HeadPoseFilter {
  params: HeadPoseParams;
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  private fz: OneEuroFilter;
  private filtered: Vec3 = { x: 0, y: 0, z: 0 };
  private defaultEye: Vec3;
  private display: Vec3;
  private holdFrom: Vec3 = { x: 0, y: 0, z: 0 };
  private blendFrom: Vec3 = { x: 0, y: 0, z: 0 };
  private tracked: Vec3 = { x: 0, y: 0, z: 0 };
  private hasData = false;
  private inLoss = false;
  private lostSince: number | null = null;
  private lastMeasT = 0;
  private blendStart = -Infinity;

  constructor(defaultEye: Vec3, filter: OneEuroParams, params: Partial<HeadPoseParams> = {}) {
    this.params = { ...DEFAULT_POSE_PARAMS, ...params };
    this.defaultEye = { ...defaultEye };
    this.display = { ...defaultEye };
    this.fx = new OneEuroFilter({ ...filter });
    this.fy = new OneEuroFilter({ ...filter });
    this.fz = new OneEuroFilter({ ...filter });
    this.setFilterParams(filter);
  }

  setFilterParams(p: OneEuroParams): void {
    this.fx.params = { ...p };
    this.fy.params = { ...p };
    this.fz.params = { ...p, minCutoff: p.minCutoff * Z_SMOOTHING_FACTOR };
  }

  setDefaultEye(e: Vec3): void {
    copyInto(this.defaultEye, e);
  }

  /** Forget all tracking history (e.g. camera stopped). */
  reset(): void {
    this.hasData = false;
    this.inLoss = false;
    this.lostSince = null;
    this.fx.reset(); this.fy.reset(); this.fz.reset();
  }

  /** A face was found in the frame captured at tMs; `eye` is in world metres. */
  onMeasurement(eye: Vec3, tMs: number): void {
    const recovering = !this.hasData || this.inLoss || this.lostSince !== null;
    if (recovering) {
      this.fx.reset(); this.fy.reset(); this.fz.reset();
      copyInto(this.blendFrom, this.display);
      this.blendStart = tMs;
    }
    const s = tMs / 1000;
    const g = this.params.gain;
    this.filtered.x = this.fx.filter(eye.x * g, s);
    this.filtered.y = this.fy.filter(eye.y * g, s);
    this.filtered.z = this.fz.filter(eye.z, s);
    this.lastMeasT = tMs;
    this.hasData = true;
    this.inLoss = false;
    this.lostSince = null;
  }

  /** A frame was processed but no face was found. */
  onNoFace(tMs: number): void {
    if (this.lostSince === null) this.lostSince = tMs;
  }

  /** Eye position to render at time nowMs. Writes into `out`. */
  sample(nowMs: number, out: Vec3): PoseState {
    const p = this.params;
    let state: PoseState;
    if (!this.hasData) {
      copyInto(out, this.defaultEye);
      state = 'no-data';
    } else {
      const lostAt = this.lostSince ?? (nowMs - this.lastMeasT > p.staleMs ? this.lastMeasT + p.staleMs : null);
      if (lostAt !== null) {
        if (!this.inLoss) {
          this.inLoss = true;
          copyInto(this.holdFrom, this.display);
        }
        const dt = nowMs - lostAt;
        if (dt < p.holdMs) {
          copyInto(out, this.holdFrom);
          state = 'holding';
        } else if (dt < p.holdMs + p.returnMs) {
          lerpInto(out, this.holdFrom, this.defaultEye, smoothstep((dt - p.holdMs) / p.returnMs));
          state = 'returning';
        } else {
          copyInto(out, this.defaultEye);
          state = 'lost';
        }
      } else {
        copyInto(this.tracked, this.filtered);
        if (p.prediction) {
          const h = Math.min(Math.max(nowMs - this.lastMeasT, 0), p.maxPredictMs) / 1000;
          this.tracked.x += this.fx.velocity * h;
          this.tracked.y += this.fy.velocity * h;
          this.tracked.z += this.fz.velocity * h;
        }
        const k = (nowMs - this.blendStart) / p.recoverMs;
        if (k < 1) lerpInto(out, this.blendFrom, this.tracked, smoothstep(k));
        else copyInto(out, this.tracked);
        state = 'tracking';
      }
    }
    if (out.z < p.minDistance) out.z = p.minDistance;
    copyInto(this.display, out);
    return state;
  }
}
