/**
 * Application HUD, top control bar, collapsible settings drawer, and fullscreen auto-hide.
 */
import {
  applyMountPreset,
  defaultConfig,
  type AppConfig,
  type Quality,
  type SceneId,
  type StereoMode,
  type TargetEyeMode,
  type WebcamMount,
} from '../config/config';
import { listCameras, type CameraDevice } from '../tracking/camera';
import type { TrackerStatus } from '../tracking/faceTracker';

export interface HudCallbacks {
  getConfig(): AppConfig;
  updateConfig(mutator: (cfg: AppConfig) => void): void;
  startCamera(): void;
  stopCamera(): void;
  setTrackingEnabled(enabled: boolean): void;
  isTrackingEnabled(): boolean;
  getTrackerStatus(): TrackerStatus;
  openCalibration(): void;
  toggleFullscreen(): void;
  resetMouseEye(): void;
}

export class AppHud {
  readonly bar: HTMLElement;
  readonly drawer: HTMLElement;
  readonly toastEl: HTMLElement;
  readonly fsPeekBtn: HTMLButtonElement;

  private settingsOpen = false;
  private cameras: CameraDevice[] = [];
  private fsHideTimer = 0;

  constructor(parent: HTMLElement, private cb: HudCallbacks) {
    this.bar = document.createElement('header');
    this.bar.className = 'vw-topbar';

    this.drawer = document.createElement('aside');
    this.drawer.className = 'vw-drawer hidden';

    this.toastEl = document.createElement('div');
    this.toastEl.className = 'vw-toast hidden';

    this.fsPeekBtn = document.createElement('button');
    this.fsPeekBtn.type = 'button';
    this.fsPeekBtn.className = 'vw-fs-peek hidden';
    this.fsPeekBtn.textContent = '☰ Controls (H)';
    this.fsPeekBtn.addEventListener('click', () => this.revealInFullscreen());

    parent.append(this.bar, this.drawer, this.toastEl, this.fsPeekBtn);
    this.renderBar();
    this.renderDrawer();
    this.setupFullscreenAutoHide();
  }

  async refreshCameras(): Promise<void> {
    this.cameras = await listCameras();
    this.renderDrawer();
  }

  showToast(message: string, isError = false, ms = 4800): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.toggle('error', isError);
    this.toastEl.classList.remove('hidden');
    window.clearTimeout((this.toastEl as unknown as { _t?: number })._t);
    (this.toastEl as unknown as { _t?: number })._t = window.setTimeout(() => {
      this.toastEl.classList.add('hidden');
    }, ms);
  }

  private setupFullscreenAutoHide(): void {
    const onActivity = () => {
      if (!document.fullscreenElement) {
        this.bar.classList.remove('fs-hidden');
        this.fsPeekBtn.classList.add('hidden');
        window.clearTimeout(this.fsHideTimer);
        return;
      }
      if (!this.bar.classList.contains('fs-hidden')) {
        this.scheduleFsHide();
      }
    };
    window.addEventListener('pointermove', onActivity, { passive: true });
    document.addEventListener('fullscreenchange', () => {
      this.renderBar();
      if (document.fullscreenElement) {
        this.scheduleFsHide();
      } else {
        window.clearTimeout(this.fsHideTimer);
        this.bar.classList.remove('fs-hidden');
        this.fsPeekBtn.classList.add('hidden');
      }
    });
  }

  private scheduleFsHide(): void {
    window.clearTimeout(this.fsHideTimer);
    this.fsHideTimer = window.setTimeout(() => {
      if (document.fullscreenElement && !this.settingsOpen) {
        this.bar.classList.add('fs-hidden');
        this.fsPeekBtn.classList.remove('hidden');
      }
    }, 2600);
  }

  revealInFullscreen(): void {
    this.bar.classList.remove('fs-hidden');
    this.fsPeekBtn.classList.add('hidden');
    this.scheduleFsHide();
  }

  toggleSettings(force?: boolean): void {
    this.settingsOpen = force ?? !this.settingsOpen;
    this.drawer.classList.toggle('hidden', !this.settingsOpen);
    if (this.settingsOpen) {
      this.refreshCameras();
      this.bar.classList.remove('fs-hidden');
      this.fsPeekBtn.classList.add('hidden');
    } else if (document.fullscreenElement) {
      this.scheduleFsHide();
    }
    this.renderBar();
  }

  renderBar(): void {
    const cfg = this.cb.getConfig();
    const status = this.cb.getTrackerStatus();
    const camRunning = status === 'running' || status === 'starting' || status === 'loading-model';
    const tracking = this.cb.isTrackingEnabled();
    const isFs = !!document.fullscreenElement;

    const statusBadge =
      status === 'running' && tracking
        ? `<span class="vw-status ok">● Head Tracking</span>`
        : status === 'loading-model' || status === 'starting'
          ? `<span class="vw-status warn">◌ Starting Camera…</span>`
          : `<span class="vw-status sim">◎ Mouse Sim (scroll = Z)</span>`;

    this.bar.innerHTML = `
      <div class="vw-brand">
        <span class="vw-logo">◫</span>
        <span class="vw-title">Virtual Window</span>
        ${statusBadge}
      </div>
      <div class="vw-controls">
        <button type="button" class="vw-btn ${camRunning ? 'danger' : 'primary'}" id="hud-cam">
          ${camRunning ? 'Stop Camera' : 'Start Camera'}
        </button>
        <button type="button" class="vw-btn ${tracking && camRunning ? 'active' : ''}" id="hud-track" title="Toggle between Webcam Head Tracking and Mouse Simulation">
          ${tracking ? 'Disable Tracking' : 'Enable Tracking'}
        </button>
        <button type="button" class="vw-btn" id="hud-cal">Recalibrate</button>
        <select id="hud-scene" class="vw-select" aria-label="Select Scene">
          <option value="room" ${cfg.render.scene === 'room' ? 'selected' : ''}>Scene: Virtual Room</option>
          <option value="calibration" ${cfg.render.scene === 'calibration' ? 'selected' : ''}>Scene: Depth Calibration</option>
          <option value="floating" ${cfg.render.scene === 'floating' ? 'selected' : ''}>Scene: Floating Objects</option>
        </select>
        <button type="button" class="vw-btn ${cfg.debug.perf ? 'active' : ''}" id="hud-perf" title="Show/Hide Performance Stats">
          Stats
        </button>
        <button type="button" class="vw-btn" id="hud-fs">
          ${isFs ? 'Exit Fullscreen' : 'Enter Fullscreen'}
        </button>
        <button type="button" class="vw-btn ${this.settingsOpen ? 'active' : ''}" id="hud-settings">
          ⚙ Settings
        </button>
      </div>
    `;

    const q = <T extends HTMLElement>(s: string) => this.bar.querySelector<T>(s);
    q('#hud-cam')?.addEventListener('click', () => {
      if (camRunning) this.cb.stopCamera();
      else this.cb.startCamera();
    });
    q('#hud-track')?.addEventListener('click', () => {
      this.cb.setTrackingEnabled(!tracking);
    });
    q('#hud-cal')?.addEventListener('click', () => this.cb.openCalibration());
    q<HTMLSelectElement>('#hud-scene')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value as SceneId;
      this.cb.updateConfig((c) => {
        c.render.scene = val;
      });
      this.renderDrawer();
    });
    q('#hud-perf')?.addEventListener('click', () => {
      this.cb.updateConfig((c) => {
        c.debug.perf = !c.debug.perf;
      });
      this.renderBar();
      this.renderDrawer();
    });
    q('#hud-fs')?.addEventListener('click', () => this.cb.toggleFullscreen());
    q('#hud-settings')?.addEventListener('click', () => this.toggleSettings());
  }

  renderDrawer(): void {
    const cfg = this.cb.getConfig();
    const isCustom = cfg.webcam.mount === 'custom';
    const camOptions = [
      `<option value="" ${cfg.webcam.deviceId === '' ? 'selected' : ''}>Default Webcam</option>`,
      ...this.cameras.map(
        (d) => `<option value="${d.deviceId}" ${cfg.webcam.deviceId === d.deviceId ? 'selected' : ''}>${d.label}</option>`,
      ),
    ].join('');

    this.drawer.innerHTML = `
      <div class="vw-drawer-head">
        <h3>Settings &amp; Configuration</h3>
        <button type="button" class="vw-icon-btn" id="drw-close" title="Close Settings">✕</button>
      </div>
      <div class="vw-drawer-body">
        <section class="vw-sec">
          <h4>Physical Screen Dimensions</h4>
          <div class="vw-form-grid">
            <label>Width (cm)
              <input type="number" step="0.1" min="10" max="300" id="set-sw" value="${cfg.screen.widthCm}" />
            </label>
            <label>Height (cm)
              <input type="number" step="0.1" min="10" max="200" id="set-sh" value="${cfg.screen.heightCm}" />
            </label>
            <label>Resolution X
              <input type="number" step="1" id="set-rx" value="${cfg.screen.resolutionX}" />
            </label>
            <label>Resolution Y
              <input type="number" step="1" id="set-ry" value="${cfg.screen.resolutionY}" />
            </label>
            <label class="vw-check full">
              <input type="checkbox" id="set-peephole" ${cfg.screen.windowPeephole ? 'checked' : ''} />
              Windowed Peephole Mode (anchor room to physical monitor)
            </label>
          </div>
        </section>

        <section class="vw-sec">
          <h4>Webcam &amp; Eye Calibration</h4>
          <div class="vw-form-grid">
            <label class="full">Camera Device
              <select id="set-dev">${camOptions}</select>
            </label>
            <label>Mount Position
              <select id="set-mount">
                <option value="top-center" ${cfg.webcam.mount === 'top-center' ? 'selected' : ''}>Top Center</option>
                <option value="top-left" ${cfg.webcam.mount === 'top-left' ? 'selected' : ''}>Top Left</option>
                <option value="top-right" ${cfg.webcam.mount === 'top-right' ? 'selected' : ''}>Top Right</option>
                <option value="bottom-center" ${cfg.webcam.mount === 'bottom-center' ? 'selected' : ''}>Bottom Center</option>
                <option value="custom" ${cfg.webcam.mount === 'custom' ? 'selected' : ''}>Custom</option>
              </select>
            </label>
            <label>Bezel Gap (cm)
              <input type="number" step="0.1" id="set-bezel" value="${cfg.webcam.bezelCm}" ${isCustom ? 'disabled' : ''} />
            </label>
            <label>Offset X (cm)
              <input type="number" step="0.1" id="set-ox" value="${cfg.webcam.offsetXCm}" ${!isCustom ? 'readonly' : ''} />
            </label>
            <label>Offset Y (cm)
              <input type="number" step="0.1" id="set-oy" value="${cfg.webcam.offsetYCm}" ${!isCustom ? 'readonly' : ''} />
            </label>
            <label>Depth Offset Z (cm)
              <input type="number" step="0.1" id="set-oz" value="${cfg.webcam.offsetZCm}" />
            </label>
            <label>Tilt Pitch (°)
              <input type="number" step="0.5" id="set-pitch" value="${cfg.webcam.pitchDeg}" />
            </label>
            <label>Camera HFOV (°)
              <input type="number" step="0.5" id="set-hfov" value="${cfg.webcam.hfovDeg.toFixed(1)}" />
            </label>
            <label>Eye IPD (mm)
              <input type="number" step="0.5" id="set-ipd" value="${cfg.eye.ipdMm}" />
            </label>
            <label>Default Distance (cm)
              <input type="number" step="1" id="set-defd" value="${cfg.eye.defaultDistanceCm}" />
            </label>
            <label>Tracked Eye
              <select id="set-teye">
                <option value="cyclopean" ${cfg.eye.targetEye === 'cyclopean' ? 'selected' : ''}>Midpoint (Both Eyes)</option>
                <option value="left" ${cfg.eye.targetEye === 'left' ? 'selected' : ''}>Left Eye (Monocular)</option>
                <option value="right" ${cfg.eye.targetEye === 'right' ? 'selected' : ''}>Right Eye (Monocular)</option>
              </select>
            </label>
          </div>
        </section>

        <section class="vw-sec">
          <h4>Tracking Stability &amp; Feel</h4>
          <div class="vw-form-grid">
            <label>Smoothing (${Math.round(cfg.tracking.smoothing * 100)}%)
              <input type="range" min="0" max="1" step="0.05" id="set-smooth" value="${cfg.tracking.smoothing}" />
            </label>
            <label>Responsiveness (${Math.round(cfg.tracking.responsiveness * 100)}%)
              <input type="range" min="0" max="1" step="0.05" id="set-resp" value="${cfg.tracking.responsiveness}" />
            </label>
            <label>Parallax Gain (${cfg.tracking.gain.toFixed(2)}×)
              <input type="range" min="0.5" max="2.0" step="0.05" id="set-gain" value="${cfg.tracking.gain}" />
            </label>
            <label class="vw-check">
              <input type="checkbox" id="set-pred" ${cfg.tracking.prediction ? 'checked' : ''} />
              Latency Motion Prediction
            </label>
          </div>
        </section>

        <section class="vw-sec">
          <h4>Rendering &amp; Quality</h4>
          <div class="vw-form-grid">
            <label>Graphics Quality
              <select id="set-qual">
                <option value="low" ${cfg.render.quality === 'low' ? 'selected' : ''}>Low (1.0× DPR, No Shadows)</option>
                <option value="medium" ${cfg.render.quality === 'medium' ? 'selected' : ''}>Medium (1.5× DPR, Soft Shadows)</option>
                <option value="high" ${cfg.render.quality === 'high' ? 'selected' : ''}>High (2.0× DPR, Soft Shadows)</option>
              </select>
            </label>
            <label>Target Frame Rate
              <select id="set-fps">
                <option value="0" ${cfg.render.targetFps === 0 ? 'selected' : ''}>Uncapped / VSync</option>
                <option value="60" ${cfg.render.targetFps === 60 ? 'selected' : ''}>60 FPS</option>
                <option value="120" ${cfg.render.targetFps === 120 ? 'selected' : ''}>120 FPS</option>
                <option value="144" ${cfg.render.targetFps === 144 ? 'selected' : ''}>144 FPS</option>
              </select>
            </label>
            <label class="full">Stereoscopic Output
              <select id="set-stereo">
                <option value="off" ${cfg.render.stereo === 'off' ? 'selected' : ''}>Off (Head-Coupled 2D Window)</option>
                <option value="anaglyph" ${cfg.render.stereo === 'anaglyph' ? 'selected' : ''}>Red / Cyan Anaglyph 3D</option>
              </select>
            </label>
          </div>
        </section>

        <section class="vw-sec">
          <h4>Debugging &amp; Visualization</h4>
          <div class="vw-checks-col">
            <label class="vw-check">
              <input type="checkbox" id="set-dbg-perf" ${cfg.debug.perf ? 'checked' : ''} />
              Show Performance Badge (FPS &amp; Latency)
            </label>
            <label class="vw-check">
              <input type="checkbox" id="set-dbg-ovl" ${cfg.debug.overlay ? 'checked' : ''} />
              Show Projection &amp; Eye Telemetry Overlay
            </label>
            <label class="vw-check">
              <input type="checkbox" id="set-dbg-3d" ${cfg.debug.view3d ? 'checked' : ''} />
              Show 3D Frustum &amp; Screen Geometry View
            </label>
            <label class="vw-check">
              <input type="checkbox" id="set-dbg-prev" ${cfg.debug.preview ? 'checked' : ''} />
              Show Webcam Preview with Face Landmarks
            </label>
            <label class="vw-check">
              <input type="checkbox" id="set-dbg-frame" ${cfg.debug.screenFrame ? 'checked' : ''} />
              Highlight Physical Screen Boundary (z = 0)
            </label>
          </div>
        </section>

        <div class="vw-drawer-actions">
          <button type="button" class="vw-btn" id="set-recenter">Recenter Mouse Eye (R)</button>
          <button type="button" class="vw-btn" id="set-defaults">Reset Defaults</button>
        </div>
      </div>
    `;

    this.bindDrawerEvents();
  }

  private bindDrawerEvents(): void {
    const q = <T extends HTMLElement>(s: string) => this.drawer.querySelector<T>(s);
    q('#drw-close')?.addEventListener('click', () => this.toggleSettings(false));

    const bindNum = (sel: string, apply: (c: AppConfig, v: number) => void) => {
      q<HTMLInputElement>(sel)?.addEventListener('change', (e) => {
        const v = parseFloat((e.target as HTMLInputElement).value);
        if (!Number.isFinite(v)) return;
        this.cb.updateConfig((c) => apply(c, v));
        this.renderDrawer();
      });
    };

    bindNum('#set-sw', (c, v) => { c.screen.widthCm = v; applyMountPreset(c); });
    bindNum('#set-sh', (c, v) => { c.screen.heightCm = v; applyMountPreset(c); });
    bindNum('#set-rx', (c, v) => { c.screen.resolutionX = Math.round(v); c.screen.autoResolution = false; });
    bindNum('#set-ry', (c, v) => { c.screen.resolutionY = Math.round(v); c.screen.autoResolution = false; });
    bindNum('#set-bezel', (c, v) => { c.webcam.bezelCm = v; applyMountPreset(c); });
    bindNum('#set-ox', (c, v) => { c.webcam.offsetXCm = v; });
    bindNum('#set-oy', (c, v) => { c.webcam.offsetYCm = v; });
    bindNum('#set-oz', (c, v) => { c.webcam.offsetZCm = v; });
    bindNum('#set-pitch', (c, v) => { c.webcam.pitchDeg = v; });
    bindNum('#set-hfov', (c, v) => { c.webcam.hfovDeg = v; });
    bindNum('#set-ipd', (c, v) => { c.eye.ipdMm = v; });
    bindNum('#set-defd', (c, v) => { c.eye.defaultDistanceCm = v; });

    q<HTMLSelectElement>('#set-dev')?.addEventListener('change', (e) => {
      const id = (e.target as HTMLSelectElement).value;
      this.cb.updateConfig((c) => { c.webcam.deviceId = id; });
      if (this.cb.getTrackerStatus() === 'running') this.cb.startCamera();
    });

    q<HTMLSelectElement>('#set-mount')?.addEventListener('change', (e) => {
      const m = (e.target as HTMLSelectElement).value as WebcamMount;
      this.cb.updateConfig((c) => {
        c.webcam.mount = m;
        applyMountPreset(c);
      });
      this.renderDrawer();
    });

    for (const [sel, fn] of [
      ['#set-smooth', (c: AppConfig, v: number) => (c.tracking.smoothing = v)],
      ['#set-resp', (c: AppConfig, v: number) => (c.tracking.responsiveness = v)],
      ['#set-gain', (c: AppConfig, v: number) => (c.tracking.gain = v)],
    ] as const) {
      q<HTMLInputElement>(sel)?.addEventListener('input', (e) => {
        const v = parseFloat((e.target as HTMLInputElement).value);
        this.cb.updateConfig((c) => fn(c, v));
        this.renderDrawer();
      });
    }

    q<HTMLInputElement>('#set-pred')?.addEventListener('change', (e) => {
      this.cb.updateConfig((c) => { c.tracking.prediction = (e.target as HTMLInputElement).checked; });
    });

    q<HTMLInputElement>('#set-peephole')?.addEventListener('change', (e) => {
      this.cb.updateConfig((c) => { c.screen.windowPeephole = (e.target as HTMLInputElement).checked; });
    });

    q<HTMLSelectElement>('#set-teye')?.addEventListener('change', (e) => {
      this.cb.updateConfig((c) => { c.eye.targetEye = (e.target as HTMLSelectElement).value as TargetEyeMode; });
    });

    q<HTMLSelectElement>('#set-stereo')?.addEventListener('change', (e) => {
      this.cb.updateConfig((c) => { c.render.stereo = (e.target as HTMLSelectElement).value as StereoMode; });
    });

    q<HTMLSelectElement>('#set-qual')?.addEventListener('change', (e) => {
      this.cb.updateConfig((c) => { c.render.quality = (e.target as HTMLSelectElement).value as Quality; });
    });

    q<HTMLSelectElement>('#set-fps')?.addEventListener('change', (e) => {
      this.cb.updateConfig((c) => { c.render.targetFps = parseInt((e.target as HTMLSelectElement).value, 10) || 0; });
    });

    for (const [sel, key] of [
      ['#set-dbg-perf', 'perf'],
      ['#set-dbg-ovl', 'overlay'],
      ['#set-dbg-3d', 'view3d'],
      ['#set-dbg-prev', 'preview'],
      ['#set-dbg-frame', 'screenFrame'],
    ] as const) {
      q<HTMLInputElement>(sel)?.addEventListener('change', (e) => {
        const checked = (e.target as HTMLInputElement).checked;
        this.cb.updateConfig((c) => { c.debug[key] = checked; });
        this.renderBar();
      });
    }

    q('#set-recenter')?.addEventListener('click', () => this.cb.resetMouseEye());
    q('#set-defaults')?.addEventListener('click', () => {
      const def = defaultConfig();
      def.calibrated = true;
      this.cb.updateConfig((c) => Object.assign(c, def));
      this.renderBar();
      this.renderDrawer();
    });
  }
}
