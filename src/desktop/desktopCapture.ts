/**
 * Continuous, GPU-efficient Windows Desktop Capture manager.
 *
 * Uses Electron's desktopCapturer (backed by Windows Graphics Capture / DXGI Desktop Duplication)
 * together with Win32 WDA_EXCLUDEFROMCAPTURE to stream the live Windows 11 desktop directly
 * into a hardware-decoded HTMLVideoElement and Three.js VideoTexture without recursive self-capture.
 */
import * as THREE from 'three';
import type { DisplayBounds } from './desktopCoordinates';

export interface DesktopDisplaySource {
  id: string;
  displayId: string;
  name: string;
  isPrimary: boolean;
  bounds: DisplayBounds & {
    dipX?: number;
    dipY?: number;
    dipWidth?: number;
    dipHeight?: number;
  };
}

export interface DesktopBridgeApi {
  isElectron: boolean;
  getSources(): Promise<DesktopDisplaySource[]>;
  setCaptureExclusion(enabled: boolean): Promise<{ ok: boolean }>;
  setAlwaysOnTop(enabled: boolean): Promise<{ ok: boolean }>;
  sendMouse(event: {
    action: 'down' | 'up' | 'click' | 'dblclick' | 'dragmove' | 'wheel';
    x: number;
    y: number;
    button?: 'left' | 'right' | 'middle';
    wheelDeltaX?: number;
    wheelDeltaY?: number;
    restoreX?: number;
    restoreY?: number;
    hasRestore?: boolean;
  }): Promise<{ ok: boolean; cursor?: string }>;
  sendKey(event: {
    action: 'down' | 'up';
    vk: number;
    extended?: boolean;
  }): Promise<{ ok: boolean }>;
  getCursorShape(): Promise<{ ok: boolean; cursor?: string }>;
  registerModeShortcut(accelerator: string): Promise<{ ok: boolean }>;
  onToggleModeShortcut(callback: () => void): () => void;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridgeApi;
  }
}

export type CaptureQuality = 'native' | '1440p' | '1080p';

export interface DesktopCaptureOptions {
  displayId: string;
  fps: 30 | 60;
  quality: CaptureQuality;
}

export interface DesktopCaptureStats {
  active: boolean;
  sourceName: string;
  width: number;
  height: number;
  aspect: number;
  captureFps: number;
  excludeFromCapture: boolean;
  error: string | null;
}

export class DesktopCaptureManager {
  private video: HTMLVideoElement;
  private texture: THREE.VideoTexture;
  private stream: MediaStream | null = null;
  private sources: DesktopDisplaySource[] = [];
  private activeSource: DesktopDisplaySource | null = null;
  private frameCount = 0;
  private lastFpsSampleMs = performance.now();
  private measuredFps = 0;
  private rvfcHandle: number | null = null;

  public stats: DesktopCaptureStats = {
    active: false,
    sourceName: 'None',
    width: 1920,
    height: 1080,
    aspect: 16 / 9,
    captureFps: 0,
    excludeFromCapture: false,
    error: null,
  };

  private onUpdateCallbacks = new Set<(stats: DesktopCaptureStats) => void>();

  constructor() {
    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;

    this.texture = new THREE.VideoTexture(this.video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
  }

  getTexture(): THREE.VideoTexture {
    return this.texture;
  }

  getVideoElement(): HTMLVideoElement {
    return this.video;
  }

  getSourcesList(): DesktopDisplaySource[] {
    return this.sources;
  }

  getActiveDisplayBounds(): DisplayBounds {
    if (this.activeSource) {
      return this.activeSource.bounds;
    }
    const dpr = window.devicePixelRatio || 1;
    return {
      x: 0,
      y: 0,
      width: Math.round((window.screen.width || 1920) * dpr),
      height: Math.round((window.screen.height || 1080) * dpr),
      scaleFactor: dpr,
    };
  }

  onUpdate(cb: (stats: DesktopCaptureStats) => void): () => void {
    this.onUpdateCallbacks.add(cb);
    return () => this.onUpdateCallbacks.delete(cb);
  }

  private notify(): void {
    for (const cb of this.onUpdateCallbacks) {
      cb(this.stats);
    }
  }

  async refreshSources(): Promise<DesktopDisplaySource[]> {
    if (window.desktopBridge?.getSources) {
      const list = await window.desktopBridge.getSources();
      if (list && list.length > 0) {
        this.sources = list;
        return list;
      }
    }
    const dpr = window.devicePixelRatio || 1;
    this.sources = [
      {
        id: 'screen:0:0',
        displayId: 'primary',
        name: 'Primary Display',
        isPrimary: true,
        bounds: {
          x: 0,
          y: 0,
          width: Math.round((window.screen.width || 1920) * dpr),
          height: Math.round((window.screen.height || 1080) * dpr),
          scaleFactor: dpr,
        },
      },
    ];
    return this.sources;
  }

  async start(opts: DesktopCaptureOptions): Promise<boolean> {
    this.stopStreamOnly();
    this.stats.error = null;

    // 1. Enable Windows capture exclusion on our own window before starting capture
    if (window.desktopBridge?.setCaptureExclusion) {
      const ex = await window.desktopBridge.setCaptureExclusion(true);
      this.stats.excludeFromCapture = Boolean(ex?.ok);
    }

    // 2. Resolve target display source
    const sources = await this.refreshSources();
    const chosen =
      sources.find((s) => s.displayId === opts.displayId || s.id === opts.displayId) ||
      sources.find((s) => s.isPrimary) ||
      sources[0] ||
      null;
    this.activeSource = chosen;

    const maxDims = this.resolveQualityDimensions(opts.quality, chosen?.bounds);

    try {
      let stream: MediaStream | null = null;

      if (window.desktopBridge?.isElectron && chosen) {
        // Electron Chromium desktop capture constraints (Windows Graphics Capture / DXGI)
        const constraints: MediaStreamConstraints = {
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: chosen.id,
              maxWidth: maxDims.width,
              maxHeight: maxDims.height,
              minFrameRate: 15,
              maxFrameRate: opts.fps,
            },
          } as unknown as MediaTrackConstraints,
        };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } else if (navigator.mediaDevices?.getDisplayMedia) {
        stream = await navigator.mediaDevices.getDisplayMedia({
          audio: false,
          video: {
            width: { ideal: maxDims.width },
            height: { ideal: maxDims.height },
            frameRate: { ideal: opts.fps, max: opts.fps },
            // Exclude current browser tab when supported
            selfBrowserSurface: 'exclude',
          } as MediaTrackConstraints,
        });
      }

      if (!stream) {
        throw new Error('Desktop capture stream unavailable');
      }

      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();

      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings?.() || {};
      const vw = this.video.videoWidth || settings.width || chosen?.bounds.width || 1920;
      const vh = this.video.videoHeight || settings.height || chosen?.bounds.height || 1080;

      this.stats.active = true;
      this.stats.sourceName = chosen?.name || 'Windows Desktop';
      this.stats.width = vw;
      this.stats.height = vh;
      this.stats.aspect = vw > 0 && vh > 0 ? vw / vh : 16 / 9;

      if (track) {
        track.onended = () => {
          this.stats.active = false;
          this.notify();
        };
      }

      this.startFrameCounter();
      this.notify();
      return true;
    } catch (err) {
      this.stats.active = false;
      this.stats.error = err instanceof Error ? err.message : String(err);
      this.notify();
      return false;
    }
  }

  private resolveQualityDimensions(
    quality: CaptureQuality,
    bounds?: DisplayBounds,
  ): { width: number; height: number } {
    const nativeW = bounds?.width || 1920;
    const nativeH = bounds?.height || 1080;
    const aspect = nativeW / Math.max(1, nativeH);
    if (quality === '1080p' && nativeH > 1080) {
      return { width: Math.round(1080 * aspect), height: 1080 };
    }
    if (quality === '1440p' && nativeH > 1440) {
      return { width: Math.round(1440 * aspect), height: 1440 };
    }
    return { width: nativeW, height: nativeH };
  }

  private startFrameCounter(): void {
    this.frameCount = 0;
    this.lastFpsSampleMs = performance.now();
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };
    if (typeof v.requestVideoFrameCallback === 'function') {
      const onFrame = () => {
        if (!this.stats.active) return;
        this.frameCount++;
        const now = performance.now();
        const elapsed = now - this.lastFpsSampleMs;
        if (elapsed >= 500) {
          this.measuredFps = (this.frameCount * 1000) / elapsed;
          this.stats.captureFps = this.measuredFps;
          if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
            this.stats.width = this.video.videoWidth;
            this.stats.height = this.video.videoHeight;
            this.stats.aspect = this.video.videoWidth / this.video.videoHeight;
          }
          this.frameCount = 0;
          this.lastFpsSampleMs = now;
        }
        this.rvfcHandle = v.requestVideoFrameCallback!(onFrame);
      };
      this.rvfcHandle = v.requestVideoFrameCallback(onFrame);
    }
  }

  /**
   * Called once per render frame by the main loop to keep stats and dimensions current.
   */
  tick(nowMs: number): void {
    if (!this.stats.active) return;
    if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
      if (
        this.stats.width !== this.video.videoWidth ||
        this.stats.height !== this.video.videoHeight
      ) {
        this.stats.width = this.video.videoWidth;
        this.stats.height = this.video.videoHeight;
        this.stats.aspect = this.video.videoWidth / this.video.videoHeight;
        this.notify();
      }
    }
    // Fallback FPS estimate if requestVideoFrameCallback is unavailable
    if (this.rvfcHandle === null && this.video.readyState >= 2) {
      this.frameCount++;
      const elapsed = nowMs - this.lastFpsSampleMs;
      if (elapsed >= 500) {
        this.stats.captureFps = (this.frameCount * 1000) / elapsed;
        this.frameCount = 0;
        this.lastFpsSampleMs = nowMs;
      }
    }
  }

  private stopStreamOnly(): void {
    const v = this.video as HTMLVideoElement & {
      cancelVideoFrameCallback?: (id: number) => void;
    };
    if (this.rvfcHandle !== null && typeof v.cancelVideoFrameCallback === 'function') {
      v.cancelVideoFrameCallback(this.rvfcHandle);
    }
    this.rvfcHandle = null;

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    this.video.srcObject = null;
    this.stats.active = false;
    this.stats.captureFps = 0;
  }

  async stop(): Promise<void> {
    this.stopStreamOnly();
    if (window.desktopBridge?.setCaptureExclusion) {
      await window.desktopBridge.setCaptureExclusion(false);
    }
    this.stats.excludeFromCapture = false;
    this.notify();
  }
}
