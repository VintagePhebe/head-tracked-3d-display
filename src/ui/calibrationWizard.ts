/**
 * Guided 4-step physical calibration wizard.
 *
 * Step 1: Physical monitor dimensions (cm) + auto-detected screen resolution
 * Step 2: Webcam mounting position and physical X/Y/Z/pitch offsets relative to screen centre
 * Step 3: Reference face capture at a comfortable central position -> solves webcam HFOV &
 *         verifies metric viewing distance using the pinhole + IPD model
 * Step 4: Perspective verification against the Depth Calibration scene & save
 */
import {
  applyMountPreset,
  sizeFromDiagonal,
  type AppConfig,
  type SceneId,
  type WebcamMount,
} from '../config/config';
import { v3 } from '../projection/offAxis';
import {
  averageMeasurements,
  estimateEye,
  solveHfovFromReference,
  solvePitchAndHfovFromTwoPoses,
  type CameraModel,
  type FaceMeasurement,
} from '../tracking/eyeEstimator';

export interface WizardHooks {
  getConfig(): AppConfig;
  applyConfig(cfg: AppConfig, save?: boolean): void;
  ensureCameraStarted(): Promise<boolean>;
  getRecentMeasurements(count: number): FaceMeasurement[];
  getCurrentEyeCm(): { x: number; y: number; z: number; state: string };
}

export class CalibrationWizard {
  readonly modal: HTMLElement;
  private step = 1;
  private prevScene: SceneId = 'room';
  private draft!: AppConfig;
  private statusTimer = 0;
  private firstRef: { m: FaceMeasurement; distM: number } | null = null;

  constructor(parent: HTMLElement, private hooks: WizardHooks) {
    this.modal = document.createElement('div');
    this.modal.className = 'vw-modal-backdrop hidden';
    parent.appendChild(this.modal);
  }

  open(): void {
    const cur = this.hooks.getConfig();
    this.prevScene = cur.render.scene;
    this.draft = structuredClone(cur);
    if (this.draft.screen.autoResolution) {
      const dpr = window.devicePixelRatio || 1;
      this.draft.screen.resolutionX = Math.round(window.screen.width * dpr);
      this.draft.screen.resolutionY = Math.round(window.screen.height * dpr);
    }
    this.step = 1;
    this.modal.classList.remove('hidden');
    this.render();
    this.startLiveStatus();
  }

  close(restoreScene = true): void {
    window.clearInterval(this.statusTimer);
    this.modal.classList.add('hidden');
    if (restoreScene) {
      const cur = this.hooks.getConfig();
      cur.render.scene = this.prevScene;
      this.hooks.applyConfig(cur, false);
    }
  }

  private startLiveStatus(): void {
    window.clearInterval(this.statusTimer);
    this.statusTimer = window.setInterval(() => {
      const el = this.modal.querySelector<HTMLElement>('[data-live-readout]');
      if (!el) return;
      const e = this.hooks.getCurrentEyeCm();
      el.textContent =
        `Live Eye Estimate: X ${e.x >= 0 ? '+' : ''}${e.x.toFixed(1)} cm, ` +
        `Y ${e.y >= 0 ? '+' : ''}${e.y.toFixed(1)} cm, ` +
        `Distance ${e.z.toFixed(1)} cm (${e.state})`;
    }, 120);
  }

  private cameraModelFromDraft(): CameraModel {
    return {
      hfovDeg: this.draft.webcam.hfovDeg,
      ipdMm: this.draft.eye.ipdMm,
      position: v3(
        this.draft.webcam.offsetXCm / 100,
        this.draft.webcam.offsetYCm / 100,
        this.draft.webcam.offsetZCm / 100,
      ),
      pitchDeg: this.draft.webcam.pitchDeg,
    };
  }

  private render(): void {
    const d = this.draft;
    // Switch background to calibration scene on steps 3 and 4 so user can visually verify perspective
    if (this.step >= 3 && d.render.scene !== 'calibration') {
      d.render.scene = 'calibration';
      this.hooks.applyConfig(d, false);
    }

    const stepsHtml = [
      '1. Monitor Size',
      '2. Webcam Mount',
      '3. Reference Capture',
      '4. Verify & Save',
    ]
      .map((label, idx) => {
        const s = idx + 1;
        const cls = s === this.step ? 'active' : s < this.step ? 'done' : '';
        return `<span class="vw-step-pill ${cls}">${label}</span>`;
      })
      .join('');

    let bodyHtml = '';
    if (this.step === 1) {
      bodyHtml = `
        <p class="vw-wiz-lead">
          Off-axis projection treats your monitor as a real physical window. Enter the width and
          height of the <b>visible display area</b> (excluding plastic bezels), or pick your screen diagonal:
        </p>
        <div class="vw-preset-row">
          <button type="button" class="vw-chip" data-diag="14">14" Laptop</button>
          <button type="button" class="vw-chip" data-diag="15.6">15.6" Laptop</button>
          <button type="button" class="vw-chip" data-diag="24">24" Monitor</button>
          <button type="button" class="vw-chip" data-diag="27">27" Monitor</button>
          <button type="button" class="vw-chip" data-diag="32">32" Monitor</button>
        </div>
        <div class="vw-form-grid">
          <label>Monitor Width (cm)
            <input type="number" step="0.1" min="10" max="300" id="wiz-w" value="${d.screen.widthCm}" />
          </label>
          <label>Monitor Height (cm)
            <input type="number" step="0.1" min="10" max="200" id="wiz-h" value="${d.screen.heightCm}" />
          </label>
          <label>Detected Resolution (px)
            <input type="text" readonly value="${d.screen.resolutionX} × ${d.screen.resolutionY}" />
          </label>
          <label>Default Viewing Distance (cm)
            <input type="number" step="1" min="20" max="200" id="wiz-def-d" value="${d.eye.defaultDistanceCm}" />
          </label>
        </div>
      `;
    } else if (this.step === 2) {
      const isCustom = d.webcam.mount === 'custom';
      bodyHtml = `
        <p class="vw-wiz-lead">
          Specify where your webcam lens sits relative to the <b>centre of the screen</b>
          (+X is right, +Y is up, +Z is out toward you).
        </p>
        <div class="vw-form-grid">
          <label>Mounting Location
            <select id="wiz-mount">
              <option value="top-center" ${d.webcam.mount === 'top-center' ? 'selected' : ''}>Top Center (above bezel)</option>
              <option value="top-left" ${d.webcam.mount === 'top-left' ? 'selected' : ''}>Top Left</option>
              <option value="top-right" ${d.webcam.mount === 'top-right' ? 'selected' : ''}>Top Right</option>
              <option value="bottom-center" ${d.webcam.mount === 'bottom-center' ? 'selected' : ''}>Bottom Bezel</option>
              <option value="custom" ${d.webcam.mount === 'custom' ? 'selected' : ''}>Custom Offsets</option>
            </select>
          </label>
          <label>Lens-to-Screen-Edge Gap (cm)
            <input type="number" step="0.1" min="0" max="20" id="wiz-bezel" value="${d.webcam.bezelCm}" ${isCustom ? 'disabled' : ''} />
          </label>
          <label>Horizontal Offset X (cm)
            <input type="number" step="0.1" id="wiz-ox" value="${d.webcam.offsetXCm}" ${!isCustom ? 'readonly' : ''} />
          </label>
          <label>Vertical Offset Y (cm)
            <input type="number" step="0.1" id="wiz-oy" value="${d.webcam.offsetYCm}" ${!isCustom ? 'readonly' : ''} />
          </label>
          <label>Depth Offset Z (cm)
            <input type="number" step="0.1" id="wiz-oz" value="${d.webcam.offsetZCm}" />
          </label>
          <label>Downward Tilt Pitch (°)
            <input type="number" step="0.5" min="-45" max="45" id="wiz-pitch" value="${d.webcam.pitchDeg}" />
          </label>
        </div>
      `;
    } else if (this.step === 3) {
      bodyHtml = `
        <p class="vw-wiz-lead">
          Sit in a comfortable central position facing the screen. Measure or estimate the
          distance from your eyes to the monitor (typically <b>55–65 cm</b>, roughly arm's length),
          then click <b>Capture Reference Position</b> to calibrate metric depth for your webcam.
        </p>
        <div class="vw-form-grid">
          <label>Measured Eye-to-Screen Distance (cm)
            <input type="number" step="1" min="25" max="150" id="wiz-ref-d" value="${d.eye.defaultDistanceCm}" />
          </label>
          <label>Inter-Pupillary Distance IPD (mm)
            <input type="number" step="0.5" min="48" max="75" id="wiz-ipd" value="${d.eye.ipdMm}" />
          </label>
          <label>Webcam Horizontal FOV (°)
            <input type="number" step="0.5" min="30" max="120" id="wiz-hfov" value="${d.webcam.hfovDeg.toFixed(1)}" />
          </label>
        </div>
        <div class="vw-wiz-actions-inline">
          <button type="button" class="vw-btn primary" id="wiz-capture">1. Capture Reference @ Distance</button>
          <button type="button" class="vw-btn" id="wiz-capture-2" ${!this.firstRef ? 'disabled' : ''} title="Lean back ~20 cm at the same eye height to solve both camera tilt pitch and HFOV">
            2. Capture @ +20 cm (Solve Pitch + FOV)
          </button>
        </div>
        <div id="wiz-cap-msg" class="vw-wiz-msg" style="margin-top:8px"></div>
        <div class="vw-live-box" data-live-readout>Live Eye Estimate: waiting…</div>
      `;
    } else {
      bodyHtml = `
        <p class="vw-wiz-lead">
          Look at the <b>Depth Calibration</b> tunnel behind this dialog and move your head left,
          right, up, down, and closer/farther:
        </p>
        <ul class="vw-wiz-checklist">
          <li>The cyan outer border at <code>0 cm (SCREEN)</code> must remain locked to the four physical monitor edges.</li>
          <li>When your eyes are centred in front of the screen, the concentric depth rings align along the central sightline.</li>
          <li>If depth changes feel too strong or too subtle, fine-tune the Webcam Horizontal FOV or Lateral Gain below.</li>
        </ul>
        <div class="vw-form-grid">
          <label>Webcam Horizontal FOV (°)
            <input type="number" step="0.5" min="30" max="120" id="wiz-hfov-4" value="${d.webcam.hfovDeg.toFixed(1)}" />
          </label>
          <label>Lateral Parallax Gain (1.0 = exact 1:1)
            <input type="number" step="0.05" min="0.5" max="2.5" id="wiz-gain-4" value="${d.tracking.gain}" />
          </label>
        </div>
        <div class="vw-live-box" data-live-readout>Live Eye Estimate: waiting…</div>
      `;
    }

    this.modal.innerHTML = `
      <div class="vw-modal">
        <div class="vw-modal-header">
          <div>
            <h2>Physical Display &amp; Webcam Calibration</h2>
            <div class="vw-steps-bar">${stepsHtml}</div>
          </div>
          <button type="button" class="vw-icon-btn" id="wiz-close" title="Close">✕</button>
        </div>
        <div class="vw-modal-body">${bodyHtml}</div>
        <div class="vw-modal-footer">
          <button type="button" class="vw-btn" id="wiz-prev" ${this.step === 1 ? 'disabled' : ''}>← Back</button>
          <div class="vw-modal-footer-right">
            <button type="button" class="vw-btn" id="wiz-cancel">Cancel</button>
            ${
              this.step < 4
                ? `<button type="button" class="vw-btn primary" id="wiz-next">Next →</button>`
                : `<button type="button" class="vw-btn primary" id="wiz-save">Save Calibration</button>`
            }
          </div>
        </div>
      </div>
    `;

    this.bindStepEvents();
  }

  private bindStepEvents(): void {
    const q = <T extends HTMLElement>(sel: string) => this.modal.querySelector<T>(sel);
    q('#wiz-close')?.addEventListener('click', () => this.close(true));
    q('#wiz-cancel')?.addEventListener('click', () => this.close(true));
    q('#wiz-prev')?.addEventListener('click', () => {
      this.readInputs();
      this.step = Math.max(1, this.step - 1);
      this.render();
    });
    q('#wiz-next')?.addEventListener('click', () => {
      this.readInputs();
      this.hooks.applyConfig(this.draft, false);
      this.step = Math.min(4, this.step + 1);
      this.render();
    });
    q('#wiz-save')?.addEventListener('click', () => {
      this.readInputs();
      this.draft.calibrated = true;
      this.draft.render.scene = this.prevScene;
      this.hooks.applyConfig(this.draft, true);
      this.close(false);
    });

    if (this.step === 1) {
      this.modal.querySelectorAll<HTMLButtonElement>('[data-diag]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const diag = parseFloat(btn.dataset.diag!);
          const sz = sizeFromDiagonal(diag, this.draft.screen.resolutionX, this.draft.screen.resolutionY);
          this.draft.screen.widthCm = sz.widthCm;
          this.draft.screen.heightCm = sz.heightCm;
          applyMountPreset(this.draft);
          this.hooks.applyConfig(this.draft, false);
          this.render();
        });
      });
    } else if (this.step === 2) {
      const mountSel = q<HTMLSelectElement>('#wiz-mount');
      const bezelInp = q<HTMLInputElement>('#wiz-bezel');
      const updateMount = () => {
        if (!mountSel || !bezelInp) return;
        this.draft.webcam.mount = mountSel.value as WebcamMount;
        this.draft.webcam.bezelCm = parseFloat(bezelInp.value) || 0;
        applyMountPreset(this.draft);
        this.render();
      };
      mountSel?.addEventListener('change', updateMount);
      bezelInp?.addEventListener('change', updateMount);
    } else if (this.step === 3) {
      const capBtn = q<HTMLButtonElement>('#wiz-capture');
      const msgEl = q<HTMLElement>('#wiz-cap-msg');
      capBtn?.addEventListener('click', async () => {
        this.readInputs();
        if (msgEl) msgEl.textContent = 'Starting webcam & sampling face landmarks…';
        capBtn.disabled = true;
        const ok = await this.hooks.ensureCameraStarted();
        if (!ok) {
          if (msgEl) msgEl.textContent = 'Webcam unavailable — using manual FOV / Mouse Simulation.';
          capBtn.disabled = false;
          return;
        }
        // Wait briefly for fresh frames
        await new Promise((r) => setTimeout(r, 450));
        const samples = this.hooks.getRecentMeasurements(15);
        const avg = averageMeasurements(samples);
        capBtn.disabled = false;
        if (!avg) {
          if (msgEl) msgEl.textContent = 'No face detected yet. Look toward the webcam and try again.';
          return;
        }
        try {
          const refDistM = this.draft.eye.defaultDistanceCm / 100;
          const solvedHfov = solveHfovFromReference(avg, this.cameraModelFromDraft(), refDistM);
          this.draft.webcam.hfovDeg = Math.min(130, Math.max(25, solvedHfov));
          this.firstRef = { m: avg, distM: refDistM };
          const est = estimateEye(avg, this.cameraModelFromDraft());
          this.hooks.applyConfig(this.draft, false);
          const hfovInp = q<HTMLInputElement>('#wiz-hfov');
          if (hfovInp) hfovInp.value = this.draft.webcam.hfovDeg.toFixed(1);
          const cap2Btn = q<HTMLButtonElement>('#wiz-capture-2');
          if (cap2Btn) cap2Btn.disabled = false;
          if (msgEl) {
            msgEl.textContent =
              `Calibrated! Solved HFOV = ${this.draft.webcam.hfovDeg.toFixed(1)}°, ` +
              `eye = (${(est.eye.x * 100).toFixed(1)}, ${(est.eye.y * 100).toFixed(1)}, ${(est.eye.z * 100).toFixed(1)} cm). ` +
              `Optional: lean back +20 cm and click button 2 to also solve camera tilt.`;
          }
        } catch (err) {
          if (msgEl) msgEl.textContent = (err as Error).message;
        }
      });

      const cap2Btn = q<HTMLButtonElement>('#wiz-capture-2');
      cap2Btn?.addEventListener('click', async () => {
        if (!this.firstRef) return;
        this.readInputs();
        cap2Btn.disabled = true;
        if (msgEl) msgEl.textContent = 'Sampling 2nd distance (+20 cm)…';
        await new Promise((r) => setTimeout(r, 450));
        const avg2 = averageMeasurements(this.hooks.getRecentMeasurements(15));
        cap2Btn.disabled = false;
        if (!avg2) {
          if (msgEl) msgEl.textContent = 'No face detected at 2nd position.';
          return;
        }
        try {
          const d2M = this.firstRef.distM + 0.2;
          const solved = solvePitchAndHfovFromTwoPoses(
            this.firstRef.m,
            this.firstRef.distM,
            avg2,
            d2M,
            this.cameraModelFromDraft(),
          );
          this.draft.webcam.pitchDeg = Math.round(solved.pitchDeg * 10) / 10;
          this.draft.webcam.hfovDeg = Math.min(130, Math.max(25, solved.hfovDeg));
          this.hooks.applyConfig(this.draft, false);
          const hfovInp = q<HTMLInputElement>('#wiz-hfov');
          if (hfovInp) hfovInp.value = this.draft.webcam.hfovDeg.toFixed(1);
          if (msgEl) {
            msgEl.textContent =
              `2-Point Calibration Complete! Pitch = ${this.draft.webcam.pitchDeg.toFixed(1)}°, ` +
              `HFOV = ${this.draft.webcam.hfovDeg.toFixed(1)}°.`;
          }
        } catch (err) {
          if (msgEl) msgEl.textContent = (err as Error).message;
        }
      });
    } else if (this.step === 4) {
      q('#wiz-hfov-4')?.addEventListener('input', () => {
        this.readInputs();
        this.hooks.applyConfig(this.draft, false);
      });
      q('#wiz-gain-4')?.addEventListener('input', () => {
        this.readInputs();
        this.hooks.applyConfig(this.draft, false);
      });
    }
  }

  private readInputs(): void {
    const num = (id: string, fallback: number) => {
      const el = this.modal.querySelector<HTMLInputElement>(id);
      if (!el) return fallback;
      const v = parseFloat(el.value);
      return Number.isFinite(v) ? v : fallback;
    };
    if (this.step === 1) {
      this.draft.screen.widthCm = num('#wiz-w', this.draft.screen.widthCm);
      this.draft.screen.heightCm = num('#wiz-h', this.draft.screen.heightCm);
      this.draft.eye.defaultDistanceCm = num('#wiz-def-d', this.draft.eye.defaultDistanceCm);
      applyMountPreset(this.draft);
    } else if (this.step === 2) {
      const m = this.modal.querySelector<HTMLSelectElement>('#wiz-mount')?.value as WebcamMount | undefined;
      if (m) this.draft.webcam.mount = m;
      this.draft.webcam.bezelCm = num('#wiz-bezel', this.draft.webcam.bezelCm);
      if (this.draft.webcam.mount === 'custom') {
        this.draft.webcam.offsetXCm = num('#wiz-ox', this.draft.webcam.offsetXCm);
        this.draft.webcam.offsetYCm = num('#wiz-oy', this.draft.webcam.offsetYCm);
      } else {
        applyMountPreset(this.draft);
      }
      this.draft.webcam.offsetZCm = num('#wiz-oz', this.draft.webcam.offsetZCm);
      this.draft.webcam.pitchDeg = num('#wiz-pitch', this.draft.webcam.pitchDeg);
    } else if (this.step === 3) {
      this.draft.eye.defaultDistanceCm = num('#wiz-ref-d', this.draft.eye.defaultDistanceCm);
      this.draft.eye.ipdMm = num('#wiz-ipd', this.draft.eye.ipdMm);
      this.draft.webcam.hfovDeg = num('#wiz-hfov', this.draft.webcam.hfovDeg);
    } else if (this.step === 4) {
      this.draft.webcam.hfovDeg = num('#wiz-hfov-4', this.draft.webcam.hfovDeg);
      this.draft.tracking.gain = num('#wiz-gain-4', this.draft.tracking.gain);
    }
  }
}
