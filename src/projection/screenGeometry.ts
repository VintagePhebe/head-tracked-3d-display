/**
 * Maps the browser canvas onto the physical monitor.
 *
 * The projection needs the *physical* rectangle (metres, world coords) actually covered by
 * the canvas. In fullscreen this is the whole visible image area of the monitor. In a
 * window it is a sub-rectangle, located from the window position on the screen.
 */
import { rectScreen, type ScreenRect } from './offAxis';

export interface MonitorSize {
  widthM: number;
  heightM: number;
}

export interface CanvasPlacement {
  /** Screen size in CSS px (window.screen.width/height). */
  screenCssW: number;
  screenCssH: number;
  /** Canvas top-left relative to the monitor's top-left, in CSS px. */
  left: number;
  top: number;
  /** Canvas size in CSS px. */
  width: number;
  height: number;
}

/** Physical rectangle covered by a canvas placed at `p` on a monitor of size `m`. */
export function canvasRect(m: MonitorSize, p: CanvasPlacement): ScreenRect {
  const sx = m.widthM / p.screenCssW;
  const sy = m.heightM / p.screenCssH;
  const x0 = -m.widthM / 2 + p.left * sx;
  const x1 = x0 + p.width * sx;
  const y1 = m.heightM / 2 - p.top * sy; // CSS y grows downward, world y grows upward
  const y0 = y1 - p.height * sy;
  return rectScreen(x0, y0, x1, y1);
}

/**
 * Best-effort placement of an element on the monitor from browser window metrics.
 * Exact in fullscreen. In a window, assumes the browser chrome is on top and borders are
 * symmetric (true for Electron and Chromium on Windows); documented as an approximation.
 */
export function measurePlacement(el: Element): CanvasPlacement {
  const r = el.getBoundingClientRect();
  const scr = window.screen as Screen & { left?: number; top?: number; availLeft?: number; availTop?: number };
  const screenCssW = scr.width;
  const screenCssH = scr.height;
  if (document.fullscreenElement) {
    // Fullscreen element fills the monitor exactly.
    return { screenCssW, screenCssH, left: r.left, top: r.top, width: r.width, height: r.height };
  }
  const border = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const chromeTop = Math.max(0, window.outerHeight - window.innerHeight - border);
  const monLeft = scr.left ?? scr.availLeft ?? 0;
  const monTop = scr.top ?? scr.availTop ?? 0;
  return {
    screenCssW,
    screenCssH,
    left: window.screenX - monLeft + border + r.left,
    top: window.screenY - monTop + chromeTop + r.top,
    width: r.width,
    height: r.height,
  };
}
