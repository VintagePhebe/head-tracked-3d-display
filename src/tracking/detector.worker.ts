/// <reference lib="webworker" />
/**
 * Face-landmark detection off the main thread. Receives ImageBitmaps, runs MediaPipe Face
 * Landmarker (GPU delegate with CPU fallback) and returns only the few numbers the eye
 * estimator needs, so rendering never waits on computer vision.
 */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { EYE_LANDMARKS, eyeAxisFromMatrix, foreshorteningFromMatrix } from './eyeEstimator';
import type { FromWorker, ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let landmarker: FaceLandmarker | null = null;
let lastTs = 0;
let lastFaceTs = -Infinity;
let smoothAxis: { x: number; y: number; z: number } | null = null;
const AXIS_ALPHA = 0.25;
const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

async function init(wasmBase: string, modelUrl: string) {
  // `true` selects the ES-module WASM loader, required inside module workers.
  const fileset = await FilesetResolver.forVisionTasks(wasmBase, true);
  const opts = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: modelUrl, delegate },
    runningMode: 'VIDEO' as const,
    numFaces: 1,
    outputFacialTransformationMatrixes: true,
    outputFaceBlendshapes: false,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  for (const delegate of ['GPU', 'CPU'] as const) {
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, opts(delegate));
      post({ type: 'ready', delegate });
      return;
    } catch (err) {
      if (delegate === 'CPU') throw err;
      console.warn('[detector] GPU delegate unavailable, falling back to CPU', err);
    }
  }
}

function detect(bitmap: ImageBitmap, t: number, wantLandmarks: boolean) {
  if (!landmarker) {
    bitmap.close();
    post({ type: 'frame-error', t, message: 'detector not ready' });
    return;
  }
  const ts = Math.max(Math.round(t), lastTs + 1); // MediaPipe requires strictly increasing timestamps
  lastTs = ts;
  const t0 = performance.now();
  try {
    const res = landmarker.detectForVideo(bitmap, ts);
    const detectMs = performance.now() - t0;
    const lm = res.faceLandmarks[0];
    if (!lm) {
      smoothAxis = null;
      post({ type: 'result', t, face: null, detectMs });
      return;
    }
    const mid = (a: number, b: number) => ({ x: (lm[a].x + lm[b].x) / 2, y: (lm[a].y + lm[b].y) / 2 });
    let landmarks: Float32Array | undefined;
    if (wantLandmarks) {
      landmarks = new Float32Array(lm.length * 2);
      for (let i = 0; i < lm.length; i++) {
        landmarks[2 * i] = lm[i].x;
        landmarks[2 * i + 1] = lm[i].y;
      }
    }
    const matData = res.facialTransformationMatrixes?.[0]?.data;
    const rawAxis = eyeAxisFromMatrix(matData);
    let eyeAxis = rawAxis;
    let foreshortening = foreshorteningFromMatrix(matData);
    if (rawAxis) {
      if (!smoothAxis || ts - lastFaceTs > 250) {
        smoothAxis = { x: rawAxis.x, y: rawAxis.y, z: rawAxis.z };
      } else {
        const x = smoothAxis.x + AXIS_ALPHA * (rawAxis.x - smoothAxis.x);
        const y = smoothAxis.y + AXIS_ALPHA * (rawAxis.y - smoothAxis.y);
        const z = smoothAxis.z + AXIS_ALPHA * (rawAxis.z - smoothAxis.z);
        const len = Math.hypot(x, y, z) || 1;
        smoothAxis = { x: x / len, y: y / len, z: z / len };
      }
      eyeAxis = smoothAxis;
      foreshortening = Math.hypot(smoothAxis.x, smoothAxis.y);
    }
    lastFaceTs = ts;
    post(
      {
        type: 'result',
        t,
        detectMs,
        face: {
          rightEye: mid(EYE_LANDMARKS.rightOuter, EYE_LANDMARKS.rightInner),
          leftEye: mid(EYE_LANDMARKS.leftInner, EYE_LANDMARKS.leftOuter),
          foreshortening,
          eyeAxis,
          landmarks,
        },
      },
      landmarks ? [landmarks.buffer] : [],
    );
  } catch (err) {
    post({ type: 'frame-error', t, message: String((err as Error)?.message ?? err) });
  } finally {
    bitmap.close();
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'init') {
    init(m.wasmBase, m.modelUrl).catch((err) => post({ type: 'init-error', message: String(err?.message ?? err) }));
  } else if (m.type === 'frame') {
    detect(m.bitmap, m.t, m.wantLandmarks);
  }
};
