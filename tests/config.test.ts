import { describe, expect, it } from 'vitest';
import {
  STORAGE_KEY, applyMountPreset, defaultConfig, loadConfig, sanitizeConfig, saveConfig, sizeFromDiagonal,
} from '../src/config/config';
import { CameraError, classifyCameraError, listCameras, openCamera } from '../src/tracking/camera';
import { WebcamFrameSanitizer } from '../src/tracking/frameSanitizer';
import { canvasRect } from '../src/projection/screenGeometry';

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}

describe('config persistence', () => {
  it('round-trips calibration settings through storage', () => {
    const s = new MemStorage();
    const c = defaultConfig();
    c.calibrated = true;
    c.screen.widthCm = 59.8;
    c.webcam.hfovDeg = 71.3;
    c.eye.ipdMm = 60;
    c.render.scene = 'floating';
    expect(saveConfig(s, c)).toBe(true);
    expect(loadConfig(s)).toEqual(c);
  });

  it('falls back to defaults on missing or corrupted data', () => {
    const s = new MemStorage();
    expect(loadConfig(s)).toEqual(defaultConfig());
    s.setItem(STORAGE_KEY, '{not json');
    expect(loadConfig(s)).toEqual(defaultConfig());
    expect(loadConfig(undefined)).toEqual(defaultConfig());
  });

  it('sanitizes types, ranges, enums and unknown keys', () => {
    const c = sanitizeConfig({
      calibrated: 'yes',
      screen: { widthCm: -5, heightCm: 'big', bogus: 1 },
      webcam: { hfovDeg: 500, mount: 'ceiling' },
      render: { scene: 'calibration', quality: 'ultra' },
      tracking: { smoothing: NaN },
    });
    const d = defaultConfig();
    expect(c.calibrated).toBe(false);
    expect(c.screen.widthCm).toBe(5);
    expect(c.screen.heightCm).toBe(d.screen.heightCm);
    expect((c.screen as unknown as Record<string, unknown>).bogus).toBeUndefined();
    expect(c.webcam.hfovDeg).toBe(150);
    expect(c.webcam.mount).toBe(d.webcam.mount);
    expect(c.render.scene).toBe('calibration');
    expect(c.render.quality).toBe(d.render.quality);
    expect(c.tracking.smoothing).toBe(d.tracking.smoothing);
  });

  it('reports failure when storage throws', () => {
    const bad = { setItem() { throw new Error('quota'); } };
    expect(saveConfig(bad, defaultConfig())).toBe(false);
  });
});

describe('physical helpers', () => {
  it('computes panel size from the diagonal', () => {
    const s = sizeFromDiagonal(27, 2560, 1440);
    expect(s.widthCm).toBeCloseTo(59.77, 1);
    expect(s.heightCm).toBeCloseTo(33.62, 1);
  });

  it('derives webcam offsets from mount presets', () => {
    const c = defaultConfig();
    c.screen.widthCm = 60; c.screen.heightCm = 34; c.webcam.bezelCm = 1.5;
    c.webcam.mount = 'top-center'; applyMountPreset(c);
    expect([c.webcam.offsetXCm, c.webcam.offsetYCm]).toEqual([0, 18.5]);
    c.webcam.mount = 'bottom-center'; applyMountPreset(c);
    expect(c.webcam.offsetYCm).toBe(-18.5);
    c.webcam.mount = 'custom'; c.webcam.offsetXCm = 7; applyMountPreset(c);
    expect(c.webcam.offsetXCm).toBe(7);
  });

  it('maps a fullscreen canvas to the whole monitor and a window to a sub-rectangle', () => {
    const m = { widthM: 0.6, heightM: 0.34 };
    const full = canvasRect(m, { screenCssW: 1920, screenCssH: 1080, left: 0, top: 0, width: 1920, height: 1080 });
    expect(full.pa).toEqual({ x: -0.3, y: -0.17, z: 0 });
    expect(full.pb.x).toBeCloseTo(0.3, 12);
    expect(full.pc.y).toBeCloseTo(0.17, 12);
    const win = canvasRect(m, { screenCssW: 1920, screenCssH: 1080, left: 960, top: 0, width: 960, height: 540 });
    expect(win.pa.x).toBeCloseTo(0, 12);
    expect(win.pb.x).toBeCloseTo(0.3, 12);
    expect(win.pa.y).toBeCloseTo(0, 12);
    expect(win.pc.y).toBeCloseTo(0.17, 12);
  });
});

describe('camera error handling', () => {
  it('classifies getUserMedia errors', () => {
    const k = (name: string) => classifyCameraError(Object.assign(new Error('x'), { name })).kind;
    expect(k('NotAllowedError')).toBe('permission-denied');
    expect(k('NotFoundError')).toBe('no-camera');
    expect(k('NotReadableError')).toBe('camera-busy');
    expect(k('Weird')).toBe('unknown');
  });

  it('reports unsupported environments', async () => {
    await expect(openCamera('', undefined)).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('surfaces permission denial as a CameraError', async () => {
    const md = {
      getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); },
      enumerateDevices: async () => [],
    };
    const err = await openCamera('', md as never).catch((e) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect(err.kind).toBe('permission-denied');
  });

  it('falls back to any camera when the stored device is missing', async () => {
    const calls: unknown[] = [];
    const md = {
      getUserMedia: async (c: MediaStreamConstraints) => {
        calls.push(c);
        if ((c.video as MediaTrackConstraints).deviceId) throw Object.assign(new Error(''), { name: 'OverconstrainedError' });
        return 'stream' as unknown as MediaStream;
      },
      enumerateDevices: async () => [],
    };
    expect(await openCamera('gone', md as never)).toBe('stream');
    expect(calls).toHaveLength(2);
  });

  it('reports no cameras when none are attached', async () => {
    const md = {
      getUserMedia: async () => { throw Object.assign(new Error(''), { name: 'NotFoundError' }); },
      enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'a', label: 'mic' }] as MediaDeviceInfo[],
    };
    expect(await listCameras(md as never)).toEqual([]);
    await expect(openCamera('', md as never)).rejects.toMatchObject({ kind: 'no-camera' });
  });

  it('prefers physical webcams over virtual camera drivers (Camo/OBS/ByteCast)', async () => {
    const calls: MediaStreamConstraints[] = [];
    const md = {
      getUserMedia: async (c: MediaStreamConstraints) => {
        calls.push(c);
        return 'physical-stream' as unknown as MediaStream;
      },
      enumerateDevices: async () => [
        { kind: 'videoinput', deviceId: 'camo-1', label: 'Camo' },
        { kind: 'videoinput', deviceId: 'obs-1', label: 'OBS Virtual Camera' },
        { kind: 'videoinput', deviceId: 'real-1', label: 'Integrated Camera' },
      ] as MediaDeviceInfo[],
    };
    expect(await openCamera('', md as never)).toBe('physical-stream');
    expect((calls[0].video as MediaTrackConstraints).deviceId).toEqual({ exact: 'real-1' });
  });

  it('rejects default webcam open when only virtual cameras exist, unless explicitly selected', async () => {
    const md = {
      getUserMedia: async () => 'virtual-stream' as unknown as MediaStream,
      enumerateDevices: async () => [
        { kind: 'videoinput', deviceId: 'camo-1', label: 'Camo' },
        { kind: 'videoinput', deviceId: 'byte-1', label: 'ByteCast VirtualCamera1' },
      ] as MediaDeviceInfo[],
    };
    await expect(openCamera('', md as never)).rejects.toMatchObject({ kind: 'no-camera' });
    expect(await openCamera('camo-1', md as never)).toBe('virtual-stream');
  });

  it('heals MJPEG-corrupted 8px MCU rows with pink/green blocks and #808080 grey abort tails', () => {
    const W = 128;
    const H = 64;
    const sanitizer = new WebcamFrameSanitizer();

    // Frame 1: clean natural image with texture gradient
    const f1 = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        f1[i] = (40 + x + y) & 0xff;
        f1[i + 1] = (90 + x * 2) & 0xff;
        f1[i + 2] = (70 + y * 2) & 0xff;
        f1[i + 3] = 255;
      }
    }
    expect(sanitizer.sanitize({ width: W, height: H, data: f1 } as ImageData)).toBe(0);

    // Frame 2: MCU row y=16..23 has garbled pink blocks at x=40..63 and #808080 grey tail at x=64..127
    const f2 = new Uint8ClampedArray(f1);
    for (let y = 16; y < 24; y++) {
      for (let x = 40; x < 64; x++) {
        const i = (y * W + x) * 4;
        f2[i] = 250;
        f2[i + 1] = 80;
        f2[i + 2] = 220;
      }
      for (let x = 64; x < W; x++) {
        const i = (y * W + x) * 4;
        f2[i] = 128;
        f2[i + 1] = 128;
        f2[i + 2] = 128;
      }
    }

    const healed = sanitizer.sanitize({ width: W, height: H, data: f2 } as ImageData);
    expect(healed).toBeGreaterThanOrEqual(8);
    // Verify the corrupted MCU row was restored to the clean frame pixels
    const checkIdx = (20 * W + 80) * 4;
    expect(f2[checkIdx]).toBe(f1[checkIdx]);
    expect(f2[checkIdx + 1]).toBe(f1[checkIdx + 1]);
    expect(f2[checkIdx + 2]).toBe(f1[checkIdx + 2]);
  });
});
