/**
 * Webcam + face-detection pipeline (main-thread side).
 *
 * Each new camera frame (requestVideoFrameCallback) is snapshotted into an ImageBitmap and
 * transferred to the detection worker. Only one frame is in flight at a time: frames that
 * arrive while the worker is busy are dropped, which keeps latency minimal instead of
 * queueing stale frames.
 */
import { CameraError, openCamera } from './camera';
import type { FaceMeasurement } from './eyeEstimator';
import type { FromWorker, ToWorker, WorkerFace } from './protocol';

export type TrackerStatus = 'stopped' | 'starting' | 'loading-model' | 'running' | 'error';

export interface TrackerCallbacks {
  onFace(m: FaceMeasurement, landmarks: Float32Array | undefined): void;
  onNoFace(t: number): void;
  onStatus(status: TrackerStatus, message?: string): void;
}

export interface TrackerStats {
  delegate: string;
  detectMs: number;
  /** Capture -> result available (ms), when the browser exposes capture timestamps. */
  latencyMs: number;
  /** Processed frames per second. */
  hz: number;
  videoWidth: number;
  videoHeight: number;
  cameraLabel: string;
}

const DETECT_WIDTH = 640; // frames are downscaled on the GPU before transfer

export class FaceTracker {
  readonly video: HTMLVideoElement;
  status: TrackerStatus = 'stopped';
  wantLandmarks = false;
  stats: TrackerStats = { delegate: '-', detectMs: 0, latencyMs: 0, hz: 0, videoWidth: 0, videoHeight: 0, cameraLabel: '' };

  private worker: Worker | null = null;
  private workerReady: Promise<void> | null = null;
  private stream: MediaStream | null = null;
  private busy = false;
  private frameCb = 0;
  private hzCount = 0;
  private hzT0 = 0;
  private session = 0;
  private oneShot: ((f: WorkerFace | null) => void) | null = null;
  private captureCanvas: HTMLCanvasElement;
  private captureCtx: CanvasRenderingContext2D;

  constructor(private cb: TrackerCallbacks) {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.captureCanvas = document.createElement('canvas');
    this.captureCanvas.width = 640;
    this.captureCanvas.height = 480;
    this.captureCtx = this.captureCanvas.getContext('2d')!;
  }

  private setStatus(s: TrackerStatus, msg?: string) {
    this.status = s;
    this.cb.onStatus(s, msg);
  }

  /** Lazily create the worker and load the model (shared across camera restarts). */
  private ensureWorker(): Promise<void> {
    if (this.workerReady) return this.workerReady;
    this.worker = new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module' });
    this.workerReady = new Promise<void>((resolve, reject) => {
      const w = this.worker!;
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === 'ready') {
          this.stats.delegate = m.delegate;
          resolve();
        } else if (m.type === 'init-error') {
          reject(new Error(`Face model failed to load: ${m.message}`));
        } else {
          this.onWorkerMessage(m);
        }
      };
      w.onerror = (e) => reject(new Error(`Detection worker failed: ${e.message}`));
      const base = document.baseURI;
      const init: ToWorker = {
        type: 'init',
        wasmBase: new URL('mediapipe/wasm', base).href,
        modelUrl: new URL('models/face_landmarker.task', base).href,
      };
      w.postMessage(init);
    });
    this.workerReady.catch(() => {
      this.worker?.terminate();
      this.worker = null;
      this.workerReady = null; // allow retry
    });
    return this.workerReady;
  }

  async start(deviceId: string): Promise<void> {
    this.stop();
    const session = ++this.session;
    this.setStatus('starting');
    try {
      const stream = await openCamera(deviceId);
      if (session !== this.session) return void stream.getTracks().forEach((t) => t.stop());
      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      this.stats.cameraLabel = track?.label ?? '';
      track?.addEventListener('ended', () => {
        if (session !== this.session) return;
        this.stop();
        this.setStatus('error', new CameraError('disconnected', 'The webcam was disconnected.').message);
      });
      this.video.srcObject = stream;
      await this.video.play();
      this.setStatus('loading-model');
      await this.ensureWorker();
      if (session !== this.session) return;
      this.stats.videoWidth = this.video.videoWidth;
      this.stats.videoHeight = this.video.videoHeight;
      this.hzT0 = performance.now();
      this.hzCount = 0;
      this.scheduleFrame(session);
      this.setStatus('running');
    } catch (err) {
      if (session !== this.session) return;
      this.stop();
      // openCamera already converts getUserMedia failures to CameraError; others are model/worker errors.
      this.setStatus('error', err instanceof Error ? err.message : String(err));
    }
  }

  stop(): void {
    this.session++;
    if (this.frameCb && 'cancelVideoFrameCallback' in this.video) this.video.cancelVideoFrameCallback(this.frameCb);
    this.frameCb = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.busy = false;
    if (this.status !== 'stopped') this.setStatus('stopped');
  }

  private scheduleFrame(session: number) {
    this.frameCb = this.video.requestVideoFrameCallback((now, meta) => {
      if (session !== this.session) return;
      if (!this.busy && this.video.videoWidth > 0) {
        const t = meta.captureTime ?? now;
        this.submit(this.video, this.video.videoWidth, this.video.videoHeight, t);
      }
      this.scheduleFrame(session);
    });
  }

  private lastW = 0;
  private lastH = 0;
  private lastVideoTime = -1;
  private lastSubmitWallMs = 0;

  /**
   * Called from the main render loop so webcam frames continue to be processed even if
   * Chromium throttles `requestVideoFrameCallback` on an offscreen `<video>` element
   * while desktop capture is active or an external Windows application holds focus.
   */
  tick(nowMs: number): void {
    if (this.status !== 'running' || this.busy) return;
    if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
      const vt = this.video.currentTime;
      if (vt !== this.lastVideoTime && nowMs - this.lastSubmitWallMs >= 12) {
        this.lastVideoTime = vt;
        this.lastSubmitWallMs = nowMs;
        this.submit(this.video, this.video.videoWidth, this.video.videoHeight, nowMs);
      }
    }
  }

  private submit(src: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement, w: number, h: number, t: number) {
    if (!this.worker) return;
    this.busy = true;
    this.lastW = w;
    this.lastH = h;
    this.lastSubmitWallMs = performance.now();
    const scale = Math.min(1, DETECT_WIDTH / w);
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));
    if (this.captureCanvas.width !== dw || this.captureCanvas.height !== dh) {
      this.captureCanvas.width = dw;
      this.captureCanvas.height = dh;
    }
    this.captureCtx.drawImage(src, 0, 0, dw, dh);
    createImageBitmap(this.captureCanvas)
      .then((bitmap) => {
        const msg: ToWorker = { type: 'frame', bitmap, t, wantLandmarks: this.wantLandmarks };
        this.worker?.postMessage(msg, [bitmap]);
      })
      .catch(() => {
        this.busy = false;
      });
  }

  private onWorkerMessage(m: FromWorker) {
    if (m.type !== 'result' && m.type !== 'frame-error') return;
    this.busy = false;
    const now = performance.now();
    this.hzCount++;
    if (now - this.hzT0 >= 1000) {
      this.stats.hz = (this.hzCount * 1000) / (now - this.hzT0);
      this.hzT0 = now;
      this.hzCount = 0;
    }
    if (m.type === 'frame-error') {
      this.oneShot?.(null);
      return;
    }
    this.stats.detectMs = m.detectMs;
    this.stats.latencyMs = now - m.t;
    if (this.oneShot) {
      this.oneShot(m.face);
      return;
    }
    if (m.face) {
      this.cb.onFace(
        {
          t: m.t,
          imageWidth: this.lastW,
          imageHeight: this.lastH,
          rightEye: m.face.rightEye,
          leftEye: m.face.leftEye,
          foreshortening: m.face.foreshortening,
          eyeAxis: m.face.eyeAxis,
        },
        m.face.landmarks,
      );
    } else {
      this.cb.onNoFace(m.t);
    }
  }

  /** Run detection on a still image (diagnostics / automated smoke test). */
  async detectStill(img: HTMLImageElement | HTMLCanvasElement): Promise<{ face: WorkerFace | null; width: number; height: number }> {
    await this.ensureWorker();
    const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
    const h = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
    const face = await new Promise<WorkerFace | null>((resolve) => {
      this.oneShot = resolve;
      this.submit(img, w, h, performance.now());
    });
    this.oneShot = null;
    return { face, width: w, height: h };
  }
}
