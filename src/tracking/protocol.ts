/** Messages exchanged between the main thread and the face-detection worker. */

export type ToWorker =
  | { type: 'init'; wasmBase: string; modelUrl: string }
  | { type: 'frame'; bitmap: ImageBitmap; t: number; wantLandmarks: boolean };

export interface WorkerFace {
  rightEye: { x: number; y: number };
  leftEye: { x: number; y: number };
  foreshortening: number;
  /** 3D unit vector of the inter-eye axis (right eye -> left eye) in camera space. */
  eyeAxis?: { x: number; y: number; z: number };
  /** Normalized (x,y) pairs of all landmarks; only sent when requested (preview). */
  landmarks?: Float32Array;
}

export type FromWorker =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'init-error'; message: string }
  | { type: 'result'; t: number; face: WorkerFace | null; detectMs: number }
  | { type: 'frame-error'; t: number; message: string };
