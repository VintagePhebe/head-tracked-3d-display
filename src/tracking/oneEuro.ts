/**
 * One Euro Filter (Casiez, Roussel, Vogel — CHI 2012): an adaptive low-pass filter whose
 * cutoff frequency rises with signal speed. Slow motion -> heavy smoothing (no jitter);
 * fast motion -> light smoothing (low lag).
 */

const alpha = (cutoffHz: number, dtS: number) => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
};

export interface OneEuroParams {
  minCutoff: number; // Hz
  beta: number; // Hz per (unit/s)
  dCutoff: number; // Hz, derivative cutoff
}

export class OneEuroFilter {
  private x = 0;
  private dx = 0;
  private t = -1;
  /** Low-passed velocity of the filtered output (units/s), used for latency prediction. */
  velocity = 0;

  constructor(public params: OneEuroParams) {}

  reset(): void {
    this.t = -1;
    this.dx = 0;
    this.velocity = 0;
  }

  /** Filter a sample at time tS (seconds). */
  filter(value: number, tS: number): number {
    if (this.t < 0) {
      this.x = value;
      this.t = tS;
      return value;
    }
    const dt = tS - this.t;
    if (dt <= 0) return this.x; // duplicate / out-of-order timestamp
    const { minCutoff, beta, dCutoff } = this.params;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(dCutoff, dt) * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    const prev = this.x;
    this.x += alpha(cutoff, dt) * (value - this.x);
    this.velocity += alpha(PREDICTION_VELOCITY_CUTOFF, dt) * ((this.x - prev) / dt - this.velocity);
    this.t = tS;
    return this.x;
  }
}

/** Cutoff (Hz) of the velocity estimate used for extrapolation. */
const PREDICTION_VELOCITY_CUTOFF = 5;

/** Map the UI's 0..1 sliders to One Euro parameters (position in metres). */
export function oneEuroFromSettings(smoothing: number, responsiveness: number): OneEuroParams {
  return {
    minCutoff: 6 * Math.pow(0.3 / 6, smoothing), // 6 Hz .. 0.3 Hz (geometric)
    beta: 60 * Math.pow(responsiveness, 1.5), // 0 .. 60 Hz per m/s
    dCutoff: 1,
  };
}
