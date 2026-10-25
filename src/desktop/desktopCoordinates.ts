/**
 * Coordinate transformation and perspective raycasting for the 3D Back-Wall Desktop.
 *
 * Maps 2D cursor positions on the physical monitor window (z = 0) through the viewer's
 * 3D eye position (x_e, y_e, z_e) onto the perspective-transformed 3D desktop surface
 * mounted on the virtual room's back wall (z = -depthM), and converts the intersection
 * to actual Windows desktop pixel coordinates.
 */
import { v3, type ScreenRect, type Vec3 } from '../projection/offAxis';

export interface DisplayBounds {
  /** Top-left X in Windows virtual-screen pixel coordinates. */
  x: number;
  /** Top-left Y in Windows virtual-screen pixel coordinates. */
  y: number;
  /** Width in physical pixels. */
  width: number;
  /** Height in physical pixels. */
  height: number;
  /** Windows DPI scale factor (e.g. 1.0, 1.25, 1.5). */
  scaleFactor: number;
}

export interface DesktopSurfaceSpec {
  /** Center X of the virtual desktop in world metres. */
  centerX: number;
  /** Center Y of the virtual desktop in world metres. */
  centerY: number;
  /** Perpendicular distance behind the physical monitor plane (world z = -depthM, metres). */
  depthM: number;
  /** Physical width of the virtual desktop surface in world metres. */
  widthM: number;
  /** Physical height of the virtual desktop surface in world metres. */
  heightM: number;
  /** Target Windows display pixel bounds. */
  display: DisplayBounds;
}

export interface DesktopRaycastHit {
  /** True when the ray hits inside the [0, 1] x [0, 1] desktop surface bounds. */
  inside: boolean;
  /** 3D intersection point on the z = -depthM plane (world metres). */
  worldPoint: Vec3;
  /** WebGL texture U coordinate (0 = left, 1 = right), clamped to [0, 1]. */
  u: number;
  /** WebGL texture V coordinate (0 = bottom, 1 = top), clamped to [0, 1]. */
  v: number;
  /** Unclamped normalized coordinates for boundary checks. */
  rawU: number;
  rawV: number;
  /** Mapped Windows virtual-screen pixel coordinate X. */
  desktopX: number;
  /** Mapped Windows virtual-screen pixel coordinate Y. */
  desktopY: number;
}

/**
 * Compute virtual desktop dimensions (widthM, heightM) that preserve the captured display's
 * exact aspect ratio while fitting within `maxWidthM x maxHeightM`.
 */
export function fitDesktopAspectRatio(
  maxWidthM: number,
  maxHeightM: number,
  displayWidthPx: number,
  displayHeightPx: number,
): { widthM: number; heightM: number; aspect: number } {
  const aspect = displayWidthPx > 0 && displayHeightPx > 0 ? displayWidthPx / displayHeightPx : 16 / 9;
  const boxAspect = maxWidthM / maxHeightM;
  if (aspect >= boxAspect) {
    return { widthM: maxWidthM, heightM: maxWidthM / aspect, aspect };
  }
  return { widthM: maxHeightM * aspect, heightM: maxHeightM, aspect };
}

/**
 * Convert normalized device coordinates (ndcX, ndcY in [-1, 1]) on the application canvas
 * to the corresponding 3D point on the physical screen rectangle `screen` (z = 0).
 */
export function ndcToScreenPoint(screen: ScreenRect, ndcX: number, ndcY: number): Vec3 {
  const sx = (ndcX + 1) * 0.5;
  const sy = (ndcY + 1) * 0.5;
  const { pa, pb, pc } = screen;
  return v3(
    pa.x + sx * (pb.x - pa.x) + sy * (pc.x - pa.x),
    pa.y + sx * (pb.y - pa.y) + sy * (pc.y - pa.y),
    pa.z + sx * (pb.z - pa.z) + sy * (pc.z - pa.z),
  );
}

/**
 * Cast a ray from the viewer's 3D `eye` position through `(ndcX, ndcY)` on the physical
 * screen rectangle `screen` and intersect it with the 3D `surface` plane at `z = -surface.depthM`.
 */
export function raycastDesktopSurface(
  eye: Vec3,
  screen: ScreenRect,
  ndcX: number,
  ndcY: number,
  surface: DesktopSurfaceSpec,
): DesktopRaycastHit | null {
  const pScreen = ndcToScreenPoint(screen, ndcX, ndcY);
  const dz = pScreen.z - eye.z;
  if (Math.abs(dz) < 1e-6) return null;

  const targetZ = -surface.depthM;
  const t = (targetZ - eye.z) / dz;
  if (t <= 0) return null;

  const wx = eye.x + t * (pScreen.x - eye.x);
  const wy = eye.y + t * (pScreen.y - eye.y);
  const worldPoint = v3(wx, wy, targetZ);

  const rawU = (wx - surface.centerX) / surface.widthM + 0.5;
  const rawV = (wy - surface.centerY) / surface.heightM + 0.5;
  const eps = 1e-6;
  const inside = rawU >= -eps && rawU <= 1 + eps && rawV >= -eps && rawV <= 1 + eps;

  const u = Math.min(1, Math.max(0, rawU));
  const v = Math.min(1, Math.max(0, rawV));
  const vTop = 1 - v; // OS screen Y grows downward from top edge (v = 1)

  const { display } = surface;
  const desktopX = display.x + Math.round(u * Math.max(0, display.width - 1));
  const desktopY = display.y + Math.round(vTop * Math.max(0, display.height - 1));

  return {
    inside,
    worldPoint,
    u,
    v,
    rawU,
    rawV,
    desktopX,
    desktopY,
  };
}

/**
 * Inverse mapping: given a Windows desktop pixel `(desktopX, desktopY)` on `surface`,
 * compute where the ray from that 3D point on the back wall to `eye` crosses the physical
 * `screen` rectangle in normalized device coordinates `[-1, 1]^2`.
 */
export function projectDesktopPixelToNdc(
  eye: Vec3,
  screen: ScreenRect,
  desktopX: number,
  desktopY: number,
  surface: DesktopSurfaceSpec,
): { ndcX: number; ndcY: number; worldPoint: Vec3 } {
  const { display } = surface;
  const u = display.width > 1 ? (desktopX - display.x) / (display.width - 1) : 0.5;
  const vTop = display.height > 1 ? (desktopY - display.y) / (display.height - 1) : 0.5;
  const v = 1 - vTop;

  const wx = surface.centerX + (u - 0.5) * surface.widthM;
  const wy = surface.centerY + (v - 0.5) * surface.heightM;
  const wz = -surface.depthM;
  const worldPoint = v3(wx, wy, wz);

  // Intersect ray eye -> worldPoint with screen plane z = 0
  const t = eye.z / (eye.z - wz);
  const sx = eye.x + t * (wx - eye.x);
  const sy = eye.y + t * (wy - eye.y);

  const screenW = screen.pb.x - screen.pa.x;
  const screenH = screen.pc.y - screen.pa.y;
  const ndcX = ((sx - screen.pa.x) / screenW) * 2 - 1;
  const ndcY = ((sy - screen.pa.y) / screenH) * 2 - 1;

  return { ndcX, ndcY, worldPoint };
}
