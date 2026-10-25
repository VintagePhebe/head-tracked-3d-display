/**
 * Interactive 3D Desktop Input Router & Mode Controller.
 *
 * Manages:
 * - Mode A ('desktop'): Routes mouse (click, double-click, right/middle click, drag, wheel)
 *   and keyboard events through perspective raycasting onto the real Windows 11 desktop.
 * - Mode B ('app'): Routes input to the 3D application's own UI and camera controls.
 * - Perspective-aligned 3D Virtual Cursor updates and native cursor hiding over the 3D desktop.
 */
import type { ScreenRect, Vec3 } from '../projection/offAxis';
import {
  raycastDesktopSurface,
  type DesktopRaycastHit,
  type DesktopSurfaceSpec,
} from './desktopCoordinates';
import type { CursorShape, DesktopSurface3D } from './desktopSurface3D';

export type InteractionMode = 'desktop' | 'app';

export interface DesktopInteractionState {
  enabled: boolean;
  interactionEnabled: boolean;
  mode: InteractionMode;
  showCursor: boolean;
  shortcut: string;
}

export interface DesktopInteractionCallbacks {
  getEye: () => Vec3;
  getScreenRect: () => ScreenRect;
  getSurfaceSpec: () => DesktopSurfaceSpec;
  onModeChange: (mode: InteractionMode) => void;
}

function isExtendedKey(e: KeyboardEvent): boolean {
  return (
    e.code.startsWith('Arrow') ||
    e.code === 'Insert' ||
    e.code === 'Delete' ||
    e.code === 'Home' ||
    e.code === 'End' ||
    e.code === 'PageUp' ||
    e.code === 'PageDown' ||
    e.code === 'NumpadEnter' ||
    e.code === 'ControlRight' ||
    e.code === 'AltRight' ||
    e.code === 'MetaLeft' ||
    e.code === 'MetaRight'
  );
}

function matchShortcut(e: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false;
  const parts = shortcut
    .toLowerCase()
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  const needAlt = parts.includes('alt');
  const needShift = parts.includes('shift');
  const needCtrl = parts.includes('ctrl') || parts.includes('control') || parts.includes('cmdorctrl');
  const mainKey = parts.find(
    (p) => p !== 'alt' && p !== 'shift' && p !== 'ctrl' && p !== 'control' && p !== 'cmdorctrl',
  );
  if (!mainKey) return false;
  if (e.altKey !== needAlt || e.shiftKey !== needShift || e.ctrlKey !== needCtrl) {
    return false;
  }
  const eventKey = e.key.toLowerCase();
  const eventCode = e.code.toLowerCase().replace(/^key/, '').replace(/^digit/, '');
  return eventKey === mainKey || eventCode === mainKey;
}

export class DesktopInteractionController {
  private canvas: HTMLCanvasElement;
  private surface3D: DesktopSurface3D;
  private callbacks: DesktopInteractionCallbacks;
  private state: DesktopInteractionState;

  private lastHit: DesktopRaycastHit | null = null;
  private isPressed = false;
  private activeButton: 'left' | 'right' | 'middle' = 'left';
  private downClientX = 0;
  private downClientY = 0;
  private virtualClientX = 0;
  private virtualClientY = 0;
  private downDesktopX = 0;
  private downDesktopY = 0;
  private lastInjectedX = 0;
  private lastInjectedY = 0;
  private hasMovedDuringPress = false;
  private lastDragSendMs = 0;

  private unsubscribeShortcut: (() => void) | null = null;
  private onHitCallbacks = new Set<(hit: DesktopRaycastHit | null) => void>();

  constructor(
    canvas: HTMLCanvasElement,
    surface3D: DesktopSurface3D,
    callbacks: DesktopInteractionCallbacks,
    initialState: DesktopInteractionState,
  ) {
    this.canvas = canvas;
    this.surface3D = surface3D;
    this.callbacks = callbacks;
    this.state = { ...initialState };

    this.bindEvents();
    this.syncGlobalShortcut(this.state.shortcut);
    this.syncAlwaysOnTop();
  }

  onHitUpdate(cb: (hit: DesktopRaycastHit | null) => void): () => void {
    this.onHitCallbacks.add(cb);
    return () => this.onHitCallbacks.delete(cb);
  }

  getLastHit(): DesktopRaycastHit | null {
    return this.lastHit;
  }

  updateState(next: DesktopInteractionState): void {
    const shortcutChanged = next.shortcut !== this.state.shortcut;
    const modeChanged =
      next.mode !== this.state.mode ||
      next.enabled !== this.state.enabled ||
      next.interactionEnabled !== this.state.interactionEnabled;

    this.state = { ...next };

    if (shortcutChanged) {
      this.syncGlobalShortcut(this.state.shortcut);
    }
    if (modeChanged) {
      this.syncAlwaysOnTop();
      if (!this.isDesktopModeActive()) {
        this.canvas.style.cursor = '';
        this.surface3D.updateCursor(0, 0, false, false);
      }
    }
  }

  isDesktopModeActive(): boolean {
    return (
      this.state.enabled &&
      this.state.interactionEnabled &&
      this.state.mode === 'desktop'
    );
  }

  toggleMode(): InteractionMode {
    const next: InteractionMode = this.state.mode === 'desktop' ? 'app' : 'desktop';
    this.state.mode = next;
    this.syncAlwaysOnTop();
    this.callbacks.onModeChange(next);
    return next;
  }

  private syncGlobalShortcut(shortcut: string): void {
    if (window.desktopBridge?.registerModeShortcut) {
      window.desktopBridge.registerModeShortcut(shortcut);
    }
    if (!this.unsubscribeShortcut && window.desktopBridge?.onToggleModeShortcut) {
      this.unsubscribeShortcut = window.desktopBridge.onToggleModeShortcut(() => {
        this.toggleMode();
      });
    }
  }

  private syncAlwaysOnTop(): void {
    if (window.desktopBridge?.setAlwaysOnTop) {
      window.desktopBridge.setAlwaysOnTop(this.isDesktopModeActive());
    }
  }

  private clientToNdc(clientX: number, clientY: number): { ndcX: number; ndcY: number } {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const ndcX = ((clientX - rect.left) / w) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / h) * 2;
    return { ndcX, ndcY };
  }

  private clientToPhysicalScreen(clientX: number, clientY: number): { x: number; y: number } {
    const dpr = window.devicePixelRatio || 1;
    return {
      x: Math.round((window.screenX + clientX) * dpr),
      y: Math.round((window.screenY + clientY) * dpr),
    };
  }

  /**
   * Perform perspective raycast from current 3D eye position through `(clientX, clientY)`
   * on the window onto the 3D back-wall desktop plane.
   */
  raycastAtClient(clientX: number, clientY: number): DesktopRaycastHit | null {
    if (!this.state.enabled) return null;
    const { ndcX, ndcY } = this.clientToNdc(clientX, clientY);
    const hit = raycastDesktopSurface(
      this.callbacks.getEye(),
      this.callbacks.getScreenRect(),
      ndcX,
      ndcY,
      this.callbacks.getSurfaceSpec(),
    );
    this.lastHit = hit;
    for (const cb of this.onHitCallbacks) {
      cb(hit);
    }
    return hit;
  }

  /**
   * Re-project the 3D virtual cursor when the viewer's head moves even if the mouse is stationary.
   */
  refreshForHeadMotion(): void {
    if (!this.state.enabled || !this.lastHit) return;
    if (this.virtualClientX === 0 && this.virtualClientY === 0) return;
    const hit = this.raycastAtClient(this.virtualClientX, this.virtualClientY);
    if (hit && hit.inside && this.state.showCursor && this.isDesktopModeActive()) {
      this.surface3D.updateCursor(hit.worldPoint.x, hit.worldPoint.y, true, this.isPressed);
    }
  }

  private bindEvents(): void {
    this.canvas.addEventListener('pointermove', (e) => this.handlePointerMove(e));
    this.canvas.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    window.addEventListener('pointerup', (e) => this.handlePointerUp(e));
    this.canvas.addEventListener('contextmenu', (e) => {
      if (this.isDesktopModeActive() && this.lastHit?.inside) {
        e.preventDefault();
      }
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        this.handleWheel(e);
      },
      { passive: false },
    );

    window.addEventListener('keydown', (e) => this.handleKeyDown(e), true);
    window.addEventListener('keyup', (e) => this.handleKeyUp(e), true);
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.state.enabled) {
      this.canvas.style.cursor = '';
      this.surface3D.updateCursor(0, 0, false, false);
      return;
    }

    const dpr = window.devicePixelRatio || 1;

    if (this.isPressed && this.isDesktopModeActive() && window.desktopBridge) {
      // Compute physical delta relative to the last injected OS cursor position so synthetic
      // SetCursorPos events produce zero delta while real hardware drags accumulate smoothly.
      const physScreenX = Math.round(e.screenX * dpr);
      const physScreenY = Math.round(e.screenY * dpr);
      const dxPx = physScreenX - this.lastInjectedX;
      const dyPx = physScreenY - this.lastInjectedY;

      if (dxPx === 0 && dyPx === 0) {
        return;
      }

      this.virtualClientX += dxPx / dpr;
      this.virtualClientY += dyPx / dpr;

      if (
        Math.hypot(this.virtualClientX - this.downClientX, this.virtualClientY - this.downClientY) >
        3
      ) {
        this.hasMovedDuringPress = true;
      }

      const hit = this.raycastAtClient(this.virtualClientX, this.virtualClientY);
      if (hit) {
        this.surface3D.updateCursor(
          hit.worldPoint.x,
          hit.worldPoint.y,
          this.state.showCursor,
          true,
        );

        const now = performance.now();
        if (this.hasMovedDuringPress && now - this.lastDragSendMs >= 14) {
          this.lastDragSendMs = now;
          this.lastInjectedX = hit.desktopX;
          this.lastInjectedY = hit.desktopY;
          window.desktopBridge
            .sendMouse({
              action: 'dragmove',
              x: hit.desktopX,
              y: hit.desktopY,
              button: this.activeButton,
              hasRestore: false,
            })
            .then((res) => {
              if (res?.cursor) this.surface3D.setCursorShape(res.cursor as CursorShape);
            });
        }
      }
      return;
    }

    this.virtualClientX = e.clientX;
    this.virtualClientY = e.clientY;
    const hit = this.raycastAtClient(e.clientX, e.clientY);

    if (hit && hit.inside && this.isDesktopModeActive()) {
      this.canvas.style.cursor = this.state.showCursor ? 'none' : '';
      this.surface3D.updateCursor(
        hit.worldPoint.x,
        hit.worldPoint.y,
        this.state.showCursor,
        this.isPressed,
      );
    } else {
      this.canvas.style.cursor = '';
      this.surface3D.updateCursor(0, 0, false, false);
    }
  }

  private handlePointerDown(e: PointerEvent): void {
    if (!this.isDesktopModeActive()) return;

    const hit = this.raycastAtClient(e.clientX, e.clientY);
    if (!hit || !hit.inside) return;

    e.preventDefault();
    e.stopPropagation();

    this.isPressed = true;
    this.hasMovedDuringPress = false;
    this.downClientX = e.clientX;
    this.downClientY = e.clientY;
    this.virtualClientX = e.clientX;
    this.virtualClientY = e.clientY;
    this.downDesktopX = hit.desktopX;
    this.downDesktopY = hit.desktopY;
    this.lastInjectedX = hit.desktopX;
    this.lastInjectedY = hit.desktopY;
    this.activeButton = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';

    this.surface3D.updateCursor(
      hit.worldPoint.x,
      hit.worldPoint.y,
      this.state.showCursor,
      true,
    );

    if (window.desktopBridge) {
      window.desktopBridge
        .sendMouse({
          action: 'down',
          x: hit.desktopX,
          y: hit.desktopY,
          button: this.activeButton,
          hasRestore: false,
        })
        .then((res) => {
          if (res?.cursor) this.surface3D.setCursorShape(res.cursor as CursorShape);
        });
    }
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this.isPressed) return;
    this.isPressed = false;

    const hit = this.raycastAtClient(this.virtualClientX, this.virtualClientY);
    const targetX = this.hasMovedDuringPress && hit ? hit.desktopX : this.downDesktopX;
    const targetY = this.hasMovedDuringPress && hit ? hit.desktopY : this.downDesktopY;
    const restore = this.clientToPhysicalScreen(this.virtualClientX, this.virtualClientY);

    if (hit) {
      this.surface3D.updateCursor(
        hit.worldPoint.x,
        hit.worldPoint.y,
        hit.inside && this.state.showCursor && this.isDesktopModeActive(),
        false,
      );
    }

    if (window.desktopBridge) {
      window.desktopBridge
        .sendMouse({
          action: 'up',
          x: targetX,
          y: targetY,
          button: this.activeButton,
          restoreX: restore.x,
          restoreY: restore.y,
          hasRestore: true,
        })
        .then((res) => {
          if (res?.cursor) this.surface3D.setCursorShape(res.cursor as CursorShape);
        });
    }

    e.preventDefault();
  }

  private handleWheel(e: WheelEvent): void {
    if (!this.isDesktopModeActive()) return;
    const hit = this.raycastAtClient(e.clientX, e.clientY);
    if (!hit || !hit.inside) return;

    e.preventDefault();
    e.stopPropagation();

    // Windows WHEEL_DELTA is 120 per notch; browser deltaY is positive when scrolling down
    const wheelDeltaY = Math.round((-e.deltaY / 100) * 120);
    const wheelDeltaX = Math.round((e.deltaX / 100) * 120);
    const restore = this.clientToPhysicalScreen(e.clientX, e.clientY);

    if (window.desktopBridge && (wheelDeltaY !== 0 || wheelDeltaX !== 0)) {
      window.desktopBridge.sendMouse({
        action: 'wheel',
        x: hit.desktopX,
        y: hit.desktopY,
        wheelDeltaX,
        wheelDeltaY,
        restoreX: restore.x,
        restoreY: restore.y,
        hasRestore: true,
      });
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (matchShortcut(e, this.state.shortcut) || e.code === 'F8') {
      e.preventDefault();
      e.stopPropagation();
      this.toggleMode();
      return;
    }

    if (!this.isDesktopModeActive()) return;
    // Allow interacting with HTML inputs if the settings panel is open
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA')
    ) {
      return;
    }
    if (e.code === 'F11') return;

    if (window.desktopBridge && e.keyCode) {
      e.preventDefault();
      e.stopPropagation();
      window.desktopBridge.sendKey({
        action: 'down',
        vk: e.keyCode,
        extended: isExtendedKey(e),
      });
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (matchShortcut(e, this.state.shortcut) || e.code === 'F8') {
      e.preventDefault();
      return;
    }
    if (!this.isDesktopModeActive()) return;
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA')
    ) {
      return;
    }
    if (e.code === 'F11') return;

    if (window.desktopBridge && e.keyCode) {
      e.preventDefault();
      e.stopPropagation();
      window.desktopBridge.sendKey({
        action: 'up',
        vk: e.keyCode,
        extended: isExtendedKey(e),
      });
    }
  }
}
