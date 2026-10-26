/**
 * Debugging & Visualization overlays:
 *  1. Performance badge (render FPS, frame time, p95, tracking rate & latency)
 *  2. Telemetry panel (eye position, viewing distance, frustum bounds, camera model)
 *  3. Frustum & Screen Geometry Inspector (real-time 3D isometric + top-down projection diagram)
 *  4. Webcam preview with overlaid MediaPipe facial landmarks and eye baseline
 */
import type { AppConfig } from '../config/config';
import type { PerfSnapshot } from '../perf/perfMonitor';
import type { OffAxisResult, ScreenRect, Vec3 } from '../projection/offAxis';
import { EYE_LANDMARKS, type FaceMeasurement } from '../tracking/eyeEstimator';
import type { TrackerStats } from '../tracking/faceTracker';
import type { PoseState } from '../tracking/headPose';

export interface DebugTelemetry {
  mode: 'webcam' | 'mouse';
  poseState: PoseState;
  eye: Vec3;
  rawMeasurement: FaceMeasurement | null;
  ipdPx: number;
  screen: ScreenRect;
  proj: OffAxisResult;
  perf: PerfSnapshot;
  tracker: TrackerStats;
  cfg: AppConfig;
}

export class DebugView {
  readonly perfEl: HTMLElement;
  readonly overlayEl: HTMLElement;
  readonly frustumWrap: HTMLElement;
  readonly previewWrap: HTMLElement;

  private frustumCanvas: HTMLCanvasElement;
  private frustumCtx: CanvasRenderingContext2D;
  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;
  private lastLandmarks: Float32Array | undefined;
  private lastTextUpdate = 0;

  constructor(container: HTMLElement) {
    this.perfEl = document.createElement('div');
    this.perfEl.className = 'vw-perf-badge hidden';

    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'vw-debug-overlay hidden';

    this.frustumWrap = document.createElement('div');
    this.frustumWrap.className = 'vw-frustum-card hidden';
    this.frustumWrap.innerHTML = `<div class="vw-card-title">Off-Axis Frustum &amp; Screen Geometry</div>`;
    this.frustumCanvas = document.createElement('canvas');
    this.frustumCanvas.width = 300;
    this.frustumCanvas.height = 220;
    this.frustumWrap.appendChild(this.frustumCanvas);
    this.frustumCtx = this.frustumCanvas.getContext('2d')!;

    this.previewWrap = document.createElement('div');
    this.previewWrap.className = 'vw-preview-card hidden';
    this.previewWrap.innerHTML = `<div class="vw-card-title">Webcam &amp; Face Landmarks</div>`;
    this.previewCanvas = document.createElement('canvas');
    this.previewCanvas.width = 280;
    this.previewCanvas.height = 158;
    this.previewWrap.appendChild(this.previewCanvas);
    this.previewCtx = this.previewCanvas.getContext('2d')!;

    container.append(this.perfEl, this.overlayEl, this.frustumWrap, this.previewWrap);
  }

  setLandmarks(lm: Float32Array | undefined): void {
    this.lastLandmarks = lm;
  }

  syncVisibility(cfg: AppConfig, isFullscreen: boolean): void {
    this.perfEl.classList.toggle('hidden', !cfg.debug.perf);
    this.overlayEl.classList.toggle('hidden', !cfg.debug.overlay);
    this.frustumWrap.classList.toggle('hidden', !cfg.debug.view3d);
    // Per specification: webcam preview is disabled by default during normal fullscreen use,
    // and only shown if explicitly enabled by the user.
    const showPreview = cfg.debug.preview && (!isFullscreen || cfg.debug.preview);
    this.previewWrap.classList.toggle('hidden', !showPreview);
  }

  update(t: DebugTelemetry, video: HTMLVideoElement, nowMs: number): void {
    const { cfg } = t;
    // Throttle DOM text updates to ~15 Hz to avoid layout churn in the render loop
    if (nowMs - this.lastTextUpdate > 65) {
      this.lastTextUpdate = nowMs;
      if (cfg.debug.perf) {
        const trackStr =
          t.mode === 'webcam'
            ? ` | Track ${t.tracker.hz.toFixed(0)} Hz (${t.tracker.detectMs.toFixed(1)} ms, ${t.tracker.delegate})`
            : ' | Mode: Mouse Sim';
        this.perfEl.textContent =
          `${t.perf.fps.toFixed(0)} FPS (${t.perf.frameMs.toFixed(1)} ms, p95 ${t.perf.p95FrameMs.toFixed(1)} ms)` +
          trackStr;
      }

      if (cfg.debug.overlay) {
        const ex = (t.eye.x * 100).toFixed(1);
        const ey = (t.eye.y * 100).toFixed(1);
        const ez = (t.eye.z * 100).toFixed(1);
        const p = t.proj;
        const hfov = ((Math.atan(p.right / p.near) - Math.atan(p.left / p.near)) * 180) / Math.PI;
        const vfov = ((Math.atan(p.top / p.near) - Math.atan(p.bottom / p.near)) * 180) / Math.PI;
        const conf = t.rawMeasurement ? `${(t.rawMeasurement.foreshortening * 100).toFixed(0)}% (IPD ${t.ipdPx.toFixed(1)} px)` : '—';
        const lat = t.mode === 'webcam' ? `${t.tracker.latencyMs.toFixed(1)} ms (CV ${t.tracker.detectMs.toFixed(1)} ms)` : '0 ms (simulated)';
        const sw = ((t.screen.pb.x - t.screen.pa.x) * 100).toFixed(1);
        const sh = ((t.screen.pc.y - t.screen.pa.y) * 100).toFixed(1);
        this.overlayEl.innerHTML = `
          <div class="vw-dbg-title">PROJECTION &amp; TRACKING TELEMETRY</div>
          <div class="vw-dbg-grid">
            <span>Input Source</span><b>${t.mode === 'webcam' ? `Webcam (${t.poseState})` : 'Mouse Simulation'}</b>
            <span>Eye Position (X, Y, Z)</span><b>${ex}, ${ey}, ${ez} cm</b>
            <span>Viewing Distance</span><b>${(p.distance * 100).toFixed(1)} cm</b>
            <span>Pose Foreshortening</span><b>${conf}</b>
            <span>Render Performance</span><b>${t.perf.fps.toFixed(1)} FPS (${t.perf.frameMs.toFixed(2)} ms)</b>
            <span>Tracking Latency</span><b>${lat}</b>
            <span>Canvas Window (W×H)</span><b>${sw} × ${sh} cm</b>
            <span>Asymmetric FOV</span><b>${hfov.toFixed(1)}° × ${vfov.toFixed(1)}°</b>
            <span>Frustum L / R (@near)</span><b>${(p.left * 1000).toFixed(2)} / ${(p.right * 1000).toFixed(2)} mm</b>
            <span>Frustum B / T (@near)</span><b>${(p.bottom * 1000).toFixed(2)} / ${(p.top * 1000).toFixed(2)} mm</b>
            <span>Near / Far Planes</span><b>${(p.near * 100).toFixed(1)} cm / ${p.far.toFixed(0)} m</b>
          </div>
        `;
      }
    }

    if (cfg.debug.view3d) {
      this.drawFrustumDiagram(t);
    }
    if (cfg.debug.preview) {
      this.drawPreview(video, t);
    }
  }

  /**
   * Draws an isometric 3D diagram of:
   *  - Virtual room box behind z = 0
   *  - Physical screen rectangle at z = 0
   *  - Webcam mount position
   *  - Current 3D eye position
   *  - The 4 off-axis frustum edges passing from the eye through the 4 physical screen corners
   */
  private drawFrustumDiagram(t: DebugTelemetry): void {
    const ctx = this.frustumCtx;
    const W = this.frustumCanvas.width;
    const H = this.frustumCanvas.height;
    ctx.clearRect(0, 0, W, H);

    const sw = t.cfg.screen.widthCm / 100;
    const sh = t.cfg.screen.heightCm / 100;
    const hw = sw / 2;
    const hh = sh / 2;
    const roomD = Math.max(0.48, sw * 1.25);

    // Oblique axonometric projection: world (x, y, z) -> 2D canvas
    const scale = Math.min(W, H) / (Math.max(sw, roomD) * 2.15);
    const cx = W * 0.52;
    const cy = H * 0.50;
    const yaw = -0.62;
    const pitch = 0.42;
    const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);

    const proj = (x: number, y: number, z: number): [number, number] => {
      const rx = x * cyaw + z * syaw;
      const rz = -x * syaw + z * cyaw;
      const ry = y * cp - rz * sp;
      return [cx + rx * scale, cy - ry * scale];
    };

    const line = (a: [number, number, number], b: [number, number, number], stroke: string, width = 1, dash: number[] = []) => {
      const [x0, y0] = proj(...a);
      const [x1, y1] = proj(...b);
      ctx.beginPath();
      ctx.setLineDash(dash);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    };

    // 1. Virtual room box (z = 0 to z = -roomD)
    const cFront: [number, number, number][] = [
      [-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0], [-hw, hh, 0],
    ];
    const cBack: [number, number, number][] = [
      [-hw, -hh, -roomD], [hw, -hh, -roomD], [hw, hh, -roomD], [-hw, hh, -roomD],
    ];
    for (let i = 0; i < 4; i++) {
      line(cBack[i], cBack[(i + 1) % 4], '#334155', 1.2);
      line(cFront[i], cBack[i], '#334155', 1.2, [3, 3]);
    }

    // 2. Frustum rays from eye through the 4 physical screen corners into the room
    const ex = t.eye.x, ey = t.eye.y, ez = Math.max(0.05, t.eye.z);
    const eyePt: [number, number, number] = [ex, ey, ez];
    for (let i = 0; i < 4; i++) {
      const [sx, sy] = cFront[i];
      // Extend ray to z = -roomD
      const k = (ez + roomD) / ez;
      const fx = ex + (sx - ex) * k;
      const fy = ey + (sy - ey) * k;
      line(eyePt, [sx, sy, 0], 'rgba(245, 158, 11, 0.75)', 1.2);
      line([sx, sy, 0], [fx, fy, -roomD], 'rgba(56, 189, 248, 0.45)', 1, [2, 3]);
    }

    // 3. Physical screen frame at z = 0 (highlighted cyan)
    for (let i = 0; i < 4; i++) {
      line(cFront[i], cFront[(i + 1) % 4], '#38bdf8', 2.4);
    }

    // 4. Optical normal axis from screen centre (0,0,0)
    line([0, 0, -roomD], [0, 0, ez], 'rgba(148, 163, 184, 0.35)', 1, [4, 4]);

    // 5. Webcam marker
    const [wx, wy] = proj(
      t.cfg.webcam.offsetXCm / 100,
      t.cfg.webcam.offsetYCm / 100,
      t.cfg.webcam.offsetZCm / 100,
    );
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(wx, wy, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // 6. Eye position dot
    const [px, py] = proj(ex, ey, ez);
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.setLineDash([]);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '11px ui-monospace, SFMono-Regular, Consolas, monospace';
    ctx.fillText(`Eye (${(ex * 100).toFixed(0)}, ${(ey * 100).toFixed(0)}, ${(ez * 100).toFixed(0)} cm)`, 8, H - 8);
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('Screen z=0', 8, 16);
  }

  private drawPreview(video: HTMLVideoElement, t: DebugTelemetry): void {
    const ctx = this.previewCtx;
    const W = this.previewCanvas.width;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      const targetH = Math.round((W * video.videoHeight) / video.videoWidth);
      if (targetH > 80 && targetH < 260 && this.previewCanvas.height !== targetH) {
        this.previewCanvas.height = targetH;
      }
    }
    const H = this.previewCanvas.height;
    ctx.clearRect(0, 0, W, H);

    if (video.readyState >= 2 && video.videoWidth > 0) {
      // Mirror horizontally so the preview behaves like a mirror
      ctx.save();
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, W, H);
      ctx.restore();
    } else {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#64748b';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(t.mode === 'webcam' ? 'Waiting for webcam…' : 'Camera stopped (Mouse mode)', W / 2, H / 2);
      return;
    }

    const lm = this.lastLandmarks;
    if (lm && lm.length >= 936) {
      ctx.fillStyle = 'rgba(56, 189, 248, 0.55)';
      for (let i = 0; i < lm.length; i += 2) {
        const x = (1 - lm[i]) * W;
        const y = lm[i + 1] * H;
        ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
      }
      // Highlight eye corners
      ctx.fillStyle = '#f59e0b';
      for (const idx of [
        EYE_LANDMARKS.rightOuter,
        EYE_LANDMARKS.rightInner,
        EYE_LANDMARKS.leftInner,
        EYE_LANDMARKS.leftOuter,
      ]) {
        const x = (1 - lm[idx * 2]) * W;
        const y = lm[idx * 2 + 1] * H;
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (t.rawMeasurement && t.poseState === 'tracking') {
      const rx = (1 - t.rawMeasurement.rightEye.x) * W;
      const ry = t.rawMeasurement.rightEye.y * H;
      const lx = (1 - t.rawMeasurement.leftEye.x) * W;
      const ly = t.rawMeasurement.leftEye.y * H;
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(lx, ly);
      ctx.stroke();

      const mx = (rx + lx) / 2;
      const my = (ry + ly) / 2;
      ctx.fillStyle = '#22c55e';
      ctx.beginPath();
      ctx.arc(mx, my, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
