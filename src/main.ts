/**
 * Application entry point: coordinates configuration, webcam head tracking, eye estimation,
 * One-Euro pose filtering, mouse simulation, off-axis perspective projection, 3D scenes,
 * calibration wizard, HUD and debug telemetry.
 */
import './styles.css';
import {
  loadConfig,
   sanitizeConfig,
  saveConfig,
  type AppConfig,
  type SceneId,
} from './config/config';
import { PerfMonitor } from './perf/perfMonitor';
import { centeredScreen, v3, type Vec3 } from './projection/offAxis';
import { canvasRect, measurePlacement } from './projection/screenGeometry';
import { OffAxisRenderer } from './render/renderer';
import { SceneManager } from './scenes/sceneManager';
import {
  estimateEye,
  selectTargetEye,
  stereoEyePair,
  type CameraModel,
  type FaceMeasurement,
} from './tracking/eyeEstimator';
import { FaceTracker } from './tracking/faceTracker';
import { HeadPoseFilter, type PoseState } from './tracking/headPose';
import { MouseSimulator } from './tracking/mouseSim';
import { oneEuroFromSettings } from './tracking/oneEuro';
import { CalibrationWizard } from './ui/calibrationWizard';
import { DebugView } from './ui/debugView';
import { AppHud } from './ui/hud';

const appEl = document.getElementById('app')!;
const canvas = document.getElementById('vw-canvas') as HTMLCanvasElement;

let cfg: AppConfig = loadConfig(window.localStorage);
if (cfg.screen.autoResolution) {
  const dpr = window.devicePixelRatio || 1;
  cfg.screen.resolutionX = Math.round(window.screen.width * dpr);
  cfg.screen.resolutionY = Math.round(window.screen.height * dpr);
}

// Core subsystems
const renderer = new OffAxisRenderer(canvas);
const scenes = new SceneManager(cfg.screen.widthCm / 100, cfg.screen.heightCm / 100, cfg.render.scene);
const perf = new PerfMonitor();
const mouseSim = new MouseSimulator(cfg.eye.defaultDistanceCm / 100);
mouseSim.attach(canvas);

const poseFilter = new HeadPoseFilter(
  v3(0, 0, cfg.eye.defaultDistanceCm / 100),
  oneEuroFromSettings(cfg.tracking.smoothing, cfg.tracking.responsiveness),
  { prediction: cfg.tracking.prediction, gain: cfg.tracking.gain },
);

let trackingEnabled = true;
let lastRawMeasurement: FaceMeasurement | null = null;
let lastIpdPx = 0;
const recentMeasurements: FaceMeasurement[] = [];
const MAX_RECENT = 30;
const estimatedEyeBuf: Vec3 = v3(0, 0, cfg.eye.defaultDistanceCm / 100);
const currentEye: Vec3 = v3(0, 0, cfg.eye.defaultDistanceCm / 100);
let currentPoseState: PoseState = 'no-data';

function getCameraModel(): CameraModel {
  return {
    hfovDeg: cfg.webcam.hfovDeg,
    ipdMm: cfg.eye.ipdMm,
    position: v3(
      cfg.webcam.offsetXCm / 100,
      cfg.webcam.offsetYCm / 100,
      cfg.webcam.offsetZCm / 100,
    ),
    pitchDeg: cfg.webcam.pitchDeg,
  };
}

const debugView = new DebugView(appEl);

const tracker = new FaceTracker({
  onFace(m, landmarks) {
    lastRawMeasurement = m;
    recentMeasurements.push(m);
    if (recentMeasurements.length > MAX_RECENT) recentMeasurements.shift();
    const est = estimateEye(m, getCameraModel(), estimatedEyeBuf);
    lastIpdPx = est.ipdPx;
    const chosenEye = selectTargetEye(est, cfg.eye.targetEye);
    poseFilter.onMeasurement(chosenEye, m.t);
    debugView.setLandmarks(landmarks);
  },
  onNoFace(t) {
    poseFilter.onNoFace(t);
    debugView.setLandmarks(undefined);
  },
  onStatus(status, message) {
    hud.renderBar();
    if (status === 'error' && message) {
      hud.showToast(message, true);
    } else if (status === 'running') {
      hud.refreshCameras();
    }
  },
});

const wizard = new CalibrationWizard(appEl, {
  getConfig: () => cfg,
  applyConfig: (next, save = true) => applyConfig(next, save),
  async ensureCameraStarted() {
    if (tracker.status !== 'running') {
      await tracker.start(cfg.webcam.deviceId);
    }
    return tracker.status === 'running';
  },
  getRecentMeasurements: (count) => recentMeasurements.slice(-count),
  getCurrentEyeCm: () => ({
    x: currentEye.x * 100,
    y: currentEye.y * 100,
    z: currentEye.z * 100,
    state: tracker.status === 'running' && trackingEnabled ? currentPoseState : 'mouse-sim',
  }),
});

const hud = new AppHud(appEl, {
  getConfig: () => cfg,
  updateConfig(mutator) {
    const draft = structuredClone(cfg);
    mutator(draft);
    applyConfig(sanitizeConfig(draft), true);
  },
  startCamera() {
    trackingEnabled = true;
    tracker.start(cfg.webcam.deviceId);
  },
  stopCamera() {
    tracker.stop();
    poseFilter.reset();
    hud.renderBar();
  },
  setTrackingEnabled(enabled) {
    trackingEnabled = enabled;
    if (enabled && tracker.status === 'stopped') {
      tracker.start(cfg.webcam.deviceId);
    }
    hud.renderBar();
  },
  isTrackingEnabled: () => trackingEnabled,
  getTrackerStatus: () => tracker.status,
  openCalibration: () => wizard.open(),
  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  },
  resetMouseEye: () => mouseSim.reset(),
});

function applyConfig(next: AppConfig, persist = true): void {
  const sizeChanged =
    next.screen.widthCm !== cfg.screen.widthCm || next.screen.heightCm !== cfg.screen.heightCm;
  const qualChanged = next.render.quality !== cfg.render.quality;

  cfg = sanitizeConfig(next);
  if (persist) saveConfig(window.localStorage, cfg);

  if (sizeChanged) {
    scenes.setScreenSize(cfg.screen.widthCm / 100, cfg.screen.heightCm / 100);
  }
  scenes.select(cfg.render.scene);
  scenes.setScreenFrameVisible(cfg.debug.screenFrame);

  if (qualChanged) {
    renderer.applyQuality(cfg.render.quality);
  }

  const defZ = cfg.eye.defaultDistanceCm / 100;
  poseFilter.setDefaultEye(v3(0, 0, defZ));
  poseFilter.setFilterParams(oneEuroFromSettings(cfg.tracking.smoothing, cfg.tracking.responsiveness));
  poseFilter.params.prediction = cfg.tracking.prediction;
  poseFilter.params.gain = cfg.tracking.gain;
  mouseSim.setDefaultDistance(defZ);

  tracker.wantLandmarks = cfg.debug.preview;
  debugView.syncVisibility(cfg, !!document.fullscreenElement);
  hud.renderBar();
}

applyConfig(cfg, false);

// Keyboard shortcuts for convenience (especially in fullscreen)
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const k = e.key.toLowerCase();
  if (k === 'f') {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  } else if (k === 's') {
    hud.toggleSettings();
  } else if (k === 'h') {
    hud.revealInFullscreen();
  } else if (k === 'c') {
    wizard.open();
  } else if (k === 'r') {
    mouseSim.reset();
  } else if (k === 't') {
    trackingEnabled = !trackingEnabled;
    hud.renderBar();
  } else if (k === '1' || k === '2' || k === '3') {
    const map: Record<string, SceneId> = { '1': 'room', '2': 'calibration', '3': 'floating' };
    cfg.render.scene = map[k];
    applyConfig(cfg, true);
    hud.renderDrawer();
  }
});

window.addEventListener('resize', () => renderer.resize());
document.addEventListener('fullscreenchange', () => {
  renderer.resize();
  debugView.syncVisibility(cfg, !!document.fullscreenElement);
});

// Prompt first-time users with a non-intrusive toast pointing to Calibration
if (!cfg.calibrated && !new URLSearchParams(window.location.search).has('smoke')) {
  hud.showToast('Move mouse (or click Start Camera) to look through the Virtual Window. Click Recalibrate to match your screen size.', false, 6500);
}

// Main real-time render loop
let lastRenderT = 0;
const startT = performance.now();

function animate(nowMs: number): void {
  requestAnimationFrame(animate);

  if (cfg.render.targetFps > 0) {
    const minInterval = 1000 / cfg.render.targetFps;
    if (nowMs - lastRenderT < minInterval * 0.92) return;
  }
  lastRenderT = nowMs;

  const dtS = perf.tick(nowMs);
  const elapsedS = (nowMs - startT) / 1000;

  const useWebcam = trackingEnabled && tracker.status === 'running';
  if (useWebcam) {
    currentPoseState = poseFilter.sample(nowMs, currentEye);
  } else {
    currentPoseState = 'no-data';
    mouseSim.sample(dtS, cfg.tracking.gain, currentEye);
  }

  const widthM = cfg.screen.widthCm / 100;
  const heightM = cfg.screen.heightCm / 100;
  const screenRect =
    cfg.screen.windowPeephole && !document.fullscreenElement
      ? canvasRect({ widthM, heightM }, measurePlacement(canvas))
      : centeredScreen(widthM, heightM);

  const proj = renderer.updateCamera(screenRect, currentEye);

  const activeScene = scenes.active;
  activeScene.update(dtS, elapsedS);
  if (cfg.render.stereo === 'anaglyph') {
    const pair = stereoEyePair(currentEye, cfg.eye.ipdMm);
    renderer.renderAnaglyph(activeScene.scene, screenRect, pair.left, pair.right);
    // Restore primary camera frustum for telemetry readout
    renderer.updateCamera(screenRect, currentEye);
  } else {
    renderer.render(activeScene.scene);
  }

  debugView.update(
    {
      mode: useWebcam ? 'webcam' : 'mouse',
      poseState: currentPoseState,
      eye: currentEye,
      rawMeasurement: lastRawMeasurement,
      ipdPx: lastIpdPx,
      screen: screenRect,
      proj,
      perf: perf.snapshot,
      tracker: tracker.stats,
      cfg,
    },
    tracker.video,
    nowMs,
  );
}

requestAnimationFrame(animate);

// Expose programmatic diagnostics for automated smoke tests and developer inspection
(window as unknown as Record<string, unknown>).__virtualWindow = {
  getConfig: () => cfg,
  applyConfig,
  mouseSim,
  tracker,
  renderer,
  scenes,
  perf,
  getCurrentEye: () => ({ ...currentEye }),
  getLastProjection: () => renderer.lastProjection,
  estimateEyeFromFace: (face: { rightEye: { x: number; y: number }; leftEye: { x: number; y: number }; foreshortening: number }, w: number, h: number) =>
    estimateEye({ t: performance.now(), imageWidth: w, imageHeight: h, ...face }, getCameraModel()),
};
