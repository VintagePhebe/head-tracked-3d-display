/**
 * Application configuration: schema, defaults, validation and persistence.
 * All physical quantities are stored in user-friendly units (cm, mm, degrees) and
 * converted to metres where used.
 */

export type SceneId = 'room' | 'calibration' | 'floating';
export type Quality = 'low' | 'medium' | 'high';
export type WebcamMount = 'top-center' | 'top-left' | 'top-right' | 'bottom-center' | 'custom';
export type TargetEyeMode = 'cyclopean' | 'left' | 'right';
export type StereoMode = 'off' | 'anaglyph';

export interface AppConfig {
  version: 1;
  calibrated: boolean;
  screen: {
    /** Visible image area (not including bezel). */
    widthCm: number;
    heightCm: number;
    resolutionX: number;
    resolutionY: number;
    autoResolution: boolean;
    /** When windowed, map the canvas to its physical sub-rectangle on the monitor. */
    windowPeephole: boolean;
  };
  webcam: {
    deviceId: string;
    mount: WebcamMount;
    /** Gap between the image area edge and the camera lens, for presets. */
    bezelCm: number;
    /** Lens position relative to the screen centre (x right, y up, z towards viewer). */
    offsetXCm: number;
    offsetYCm: number;
    offsetZCm: number;
    /** Downward tilt of the camera's optical axis relative to the screen normal. */
    pitchDeg: number;
    /** Horizontal field of view of the webcam image (calibrated from a reference distance). */
    hfovDeg: number;
  };
  eye: {
    /** Inter-pupillary distance used to convert image size to metric distance. */
    ipdMm: number;
    /** Eye distance used when no tracking is available (and for mouse simulation start). */
    defaultDistanceCm: number;
    /** Which eye drives the virtual camera in monocular mode. */
    targetEye: TargetEyeMode;
  };
  tracking: {
    /** 0..1: One-Euro minimum cutoff (more = smoother, slower). */
    smoothing: number;
    /** 0..1: One-Euro speed coefficient (more = less lag on fast moves). */
    responsiveness: number;
    /** Extrapolate between camera frames to hide tracking latency. */
    prediction: boolean;
    /** Lateral motion gain. 1.0 = physically correct; other values exaggerate/attenuate. */
    gain: number;
  };
  render: {
    quality: Quality;
    /** 0 = display refresh rate (vsync). */
    targetFps: number;
    scene: SceneId;
    /** Optional Red/Cyan anaglyph stereo off-axis rendering. */
    stereo: StereoMode;
  };
  debug: {
    overlay: boolean;
    perf: boolean;
    view3d: boolean;
    preview: boolean;
    screenFrame: boolean;
  };
}

export const STORAGE_KEY = 'virtual-window.config.v1';

export function defaultConfig(): AppConfig {
  // 24" 16:9 panel as a neutral starting point; the calibration wizard asks for real values.
  return {
    version: 1,
    calibrated: false,
    screen: {
      widthCm: 53.1,
      heightCm: 29.9,
      resolutionX: 1920,
      resolutionY: 1080,
      autoResolution: true,
      windowPeephole: false,
    },
    webcam: {
      deviceId: '',
      mount: 'top-center',
      bezelCm: 1.0,
      offsetXCm: 0,
      offsetYCm: 29.9 / 2 + 1.0,
      offsetZCm: 0,
      pitchDeg: 0,
      hfovDeg: 60,
    },
    eye: { ipdMm: 63, defaultDistanceCm: 60, targetEye: 'cyclopean' },
    tracking: { smoothing: 0.5, responsiveness: 0.5, prediction: true, gain: 1 },
    render: { quality: 'medium', targetFps: 0, scene: 'room', stereo: 'off' },
    debug: { overlay: false, perf: false, view3d: false, preview: false, screenFrame: false },
  };
}

/** Position of the webcam lens implied by a mount preset (cm, relative to screen centre). */
export function mountOffsets(cfg: AppConfig): { x: number; y: number; z: number } | null {
  const { widthCm: w, heightCm: h } = cfg.screen;
  const b = cfg.webcam.bezelCm;
  switch (cfg.webcam.mount) {
    case 'top-center': return { x: 0, y: h / 2 + b, z: 0 };
    case 'top-left': return { x: -w / 4, y: h / 2 + b, z: 0 };
    case 'top-right': return { x: w / 4, y: h / 2 + b, z: 0 };
    case 'bottom-center': return { x: 0, y: -h / 2 - b, z: 0 };
    case 'custom': return null;
  }
}

/** Re-derive webcam offsets from the mount preset (no-op for 'custom'). */
export function applyMountPreset(cfg: AppConfig): void {
  const o = mountOffsets(cfg);
  if (!o) return;
  cfg.webcam.offsetXCm = round(o.x, 2);
  cfg.webcam.offsetYCm = round(o.y, 2);
  cfg.webcam.offsetZCm = o.z;
}

/** Width/height (cm) of a panel from its diagonal (inches) and pixel aspect ratio. */
export function sizeFromDiagonal(diagIn: number, resX: number, resY: number): { widthCm: number; heightCm: number } {
  const d = diagIn * 2.54;
  const k = d / Math.hypot(resX, resY);
  return { widthCm: round(resX * k, 2), heightCm: round(resY * k, 2) };
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

type Range = [number, number];
const NUM_RANGES: Record<string, Range> = {
  'screen.widthCm': [5, 500],
  'screen.heightCm': [5, 300],
  'screen.resolutionX': [320, 16384],
  'screen.resolutionY': [200, 16384],
  'webcam.bezelCm': [0, 20],
  'webcam.offsetXCm': [-300, 300],
  'webcam.offsetYCm': [-300, 300],
  'webcam.offsetZCm': [-100, 100],
  'webcam.pitchDeg': [-45, 45],
  'webcam.hfovDeg': [20, 150],
  'eye.ipdMm': [45, 80],
  'eye.defaultDistanceCm': [15, 300],
  'tracking.smoothing': [0, 1],
  'tracking.responsiveness': [0, 1],
  'tracking.gain': [0.25, 3],
  'render.targetFps': [0, 360],
};
const ENUMS: Record<string, readonly string[]> = {
  'webcam.mount': ['top-center', 'top-left', 'top-right', 'bottom-center', 'custom'],
  'eye.targetEye': ['cyclopean', 'left', 'right'],
  'render.quality': ['low', 'medium', 'high'],
  'render.scene': ['room', 'calibration', 'floating'],
  'render.stereo': ['off', 'anaglyph'],
};

/**
 * Merge untrusted data (e.g. from localStorage) over defaults. Unknown keys are dropped,
 * wrong types fall back to defaults, numbers are clamped to sane physical ranges.
 */
export function sanitizeConfig(raw: unknown): AppConfig {
  const out = defaultConfig() as unknown as Record<string, Record<string, unknown>>;
  if (!raw || typeof raw !== 'object') return out as unknown as AppConfig;
  const src = raw as Record<string, unknown>;
  if (typeof src.calibrated === 'boolean') (out as Record<string, unknown>).calibrated = src.calibrated;
  for (const section of Object.keys(out)) {
    const d = out[section];
    const s = src[section];
    if (!d || typeof d !== 'object' || !s || typeof s !== 'object') continue;
    for (const key of Object.keys(d)) {
      const v = (s as Record<string, unknown>)[key];
      const path = `${section}.${key}`;
      const def = d[key];
      if (typeof def === 'number' && typeof v === 'number' && Number.isFinite(v)) {
        const r = NUM_RANGES[path];
        d[key] = r ? Math.min(r[1], Math.max(r[0], v)) : v;
      } else if (typeof def === 'boolean' && typeof v === 'boolean') {
        d[key] = v;
      } else if (typeof def === 'string' && typeof v === 'string') {
        const allowed = ENUMS[path];
        if (!allowed || allowed.includes(v)) d[key] = v;
      }
    }
  }
  return out as unknown as AppConfig;
}

export function loadConfig(storage: Pick<Storage, 'getItem'> | undefined): AppConfig {
  try {
    const txt = storage?.getItem(STORAGE_KEY);
    return txt ? sanitizeConfig(JSON.parse(txt)) : defaultConfig();
  } catch {
    return defaultConfig(); // corrupted JSON or storage unavailable
  }
}

export function saveConfig(storage: Pick<Storage, 'setItem'> | undefined, cfg: AppConfig): boolean {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(cfg));
    return !!storage;
  } catch {
    return false; // quota / private mode
  }
}
