/**
 * Eye-position estimation: converts 2D face landmarks from a monocular webcam into metric
 * 3D eye positions (cyclopean midpoint, left eye, right eye) in world (screen) coordinates.
 *
 * Exact Pinhole + 3D Baseline Formulation:
 *   Let r_R, r_L be the normalized camera rays ((u - cx)/f, (v - cy)/f, 1) of the right and
 *   left eyes, and d = (dx, dy, dz) be the 3D unit vector from the right eye to the left eye
 *   in camera space (from MediaPipe's facial transformation matrix).
 *   Since P_L - P_R = IPD * d, with z_R = z_c - IPD*dz/2 and z_L = z_c + IPD*dz/2:
 *     z_c * (r_L,xy - r_R,xy) = IPD * (d_xy - dz * (r_L,xy + r_R,xy) / 2)
 *   This closed-form identity eliminates both 2D yaw foreshortening and off-axis perspective
 *   foreshortening of the rotated inter-eye baseline, recovering P_R, P_L, and P_c = (P_R+P_L)/2.
 */
import { v3, type Vec3 } from '../projection/offAxis';

export type TargetEye = 'cyclopean' | 'left' | 'right';

/** One processed camera frame with a detected face (normalized image coords, unmirrored). */
export interface FaceMeasurement {
  /** Capture timestamp (ms, performance.now() domain). */
  t: number;
  imageWidth: number;
  imageHeight: number;
  /** Subject's right eye centre (appears on the image's left), normalized [0,1]. */
  rightEye: { x: number; y: number };
  leftEye: { x: number; y: number };
  /**
   * Fraction of the true eye-separation vector visible in the image plane (1 = face parallel
   * to the image plane, cos(yaw) for pure yaw). Derived from the facial transformation matrix.
   */
  foreshortening: number;
  /** Optional full 3D unit vector (right eye -> left eye) in camera space (+x right, +y down, +z forward). */
  eyeAxis?: Vec3;
}

export interface CameraModel {
  hfovDeg: number;
  ipdMm: number;
  /** Lens position relative to screen centre (metres). */
  position: Vec3;
  pitchDeg: number;
}

export interface EyeEstimate {
  /** Cyclopean midpoint between both eyes (world metres). */
  eye: Vec3;
  /** Subject's left eye position (world metres). */
  leftEye: Vec3;
  /** Subject's right eye position (world metres). */
  rightEye: Vec3;
  ipdPx: number; // corrected eye separation in pixels
  cameraDepth: number; // Zc, metres along the optical axis
}

export const focalPx = (imageWidth: number, hfovDeg: number) =>
  imageWidth / 2 / Math.tan((hfovDeg * Math.PI) / 360);

/** Corrected eye separation (pixels) and eye midpoint (pixels). */
export function eyeGeometry(m: FaceMeasurement) {
  const rx = m.rightEye.x * m.imageWidth, ry = m.rightEye.y * m.imageHeight;
  const lx = m.leftEye.x * m.imageWidth, ly = m.leftEye.y * m.imageHeight;
  const rawPx = Math.hypot(lx - rx, ly - ry);
  const fs = Math.min(1, Math.max(0.3, m.foreshortening || 1)); // guard degenerate poses
  return { rawPx, ipdPx: rawPx / fs, u: (lx + rx) / 2, v: (ly + ry) / 2, rx, ry, lx, ly, fs };
}

/**
 * Transform a camera-space point to world space.
 * Camera frame: x = image right, y = image down, z = optical axis (towards the viewer).
 * The camera faces the viewer, so image-right is world -X; a positive pitch tilts the
 * optical axis downward.
 */
function cameraToWorld(xc: number, yc: number, zc: number, cam: CameraModel, out: Vec3): Vec3 {
  const p = (cam.pitchDeg * Math.PI) / 180;
  const c = Math.cos(p), s = Math.sin(p);
  out.x = cam.position.x - xc;
  out.y = cam.position.y - yc * c - zc * s;
  out.z = cam.position.z - yc * s + zc * c;
  return out;
}

export function estimateEye(
  m: FaceMeasurement,
  cam: CameraModel,
  out: Vec3 = { x: 0, y: 0, z: 0 },
): EyeEstimate {
  const { rawPx, ipdPx, rx, ry, lx, ly, fs } = eyeGeometry(m);
  const f = focalPx(m.imageWidth, cam.hfovDeg);
  const ipd = cam.ipdMm / 1000;
  const cx = m.imageWidth / 2;
  const cy = m.imageHeight / 2;

  const rRx = (rx - cx) / f, rRy = (ry - cy) / f;
  const rLx = (lx - cx) / f, rLy = (ly - cy) / f;
  const rMx = (rRx + rLx) / 2, rMy = (rRy + rLy) / 2;

  // Determine 3D inter-eye unit vector d = (dx, dy, dz) in camera frame
  let dx: number, dy: number, dz: number;
  if (m.eyeAxis) {
    dx = m.eyeAxis.x;
    dy = m.eyeAxis.y;
    dz = m.eyeAxis.z;
  } else {
    // Reconstruct unit direction in image plane from landmark vector + foreshortening magnitude
    const ux = rawPx > 0 ? (lx - rx) / rawPx : 1;
    const uy = rawPx > 0 ? (ly - ry) / rawPx : 0;
    dx = ux * fs;
    dy = uy * fs;
    dz = 0;
  }

  // Exact perspective baseline correction:
  // zc * (rL - rR) = IPD * (d_xy - dz * rM)
  const effFs = Math.min(1.2, Math.max(0.25, Math.hypot(dx - dz * rMx, dy - dz * rMy)));
  const correctedIpdPx = rawPx / effFs;
  const zc = (f * ipd) / correctedIpdPx;

  const zR = zc - 0.5 * ipd * dz;
  const zL = zc + 0.5 * ipd * dz;

  const xR = rRx * zR, yR = rRy * zR;
  const xL = rLx * zL, yL = rLy * zL;
  const xc = (xR + xL) / 2, yc = (yR + yL) / 2;

  const rightEye = cameraToWorld(xR, yR, zR, cam, { x: 0, y: 0, z: 0 });
  const leftEye = cameraToWorld(xL, yL, zL, cam, { x: 0, y: 0, z: 0 });
  cameraToWorld(xc, yc, zc, cam, out);

  return { eye: out, leftEye, rightEye, ipdPx, cameraDepth: zc };
}

/** Select the requested eye position (cyclopean midpoint, left eye, or right eye). */
export function selectTargetEye(est: EyeEstimate, target: TargetEye): Vec3 {
  if (target === 'left') return est.leftEye;
  if (target === 'right') return est.rightEye;
  return est.eye;
}

/**
 * Given a cyclopean eye position, compute the physical left and right eye world coordinates
 * separated by `ipdMm` along the horizontal axis (used for stereo rendering).
 */
export function stereoEyePair(cyclopean: Vec3, ipdMm: number): { left: Vec3; right: Vec3 } {
  const half = ipdMm / 2000;
  // Viewer faces -Z, so the viewer's left eye is at -X and right eye is at +X.
  return {
    left: v3(cyclopean.x - half, cyclopean.y, cyclopean.z),
    right: v3(cyclopean.x + half, cyclopean.y, cyclopean.z),
  };
}

/**
 * Reference calibration: given a measurement taken while the user's eyes are at a known
 * perpendicular distance from the screen plane, solve for the webcam's horizontal FOV.
 * Closed form: Yc does not depend on f (Yc = (v-cy) * IPD / ipd_px), so
 *   z_world = camZ - Yc*sin(p) + Zc*cos(p)  =>  Zc = (D - camZ + Yc*sin(p)) / cos(p)
 *   f_px = Zc * ipd_px / IPD,  hfov = 2 atan(w/2 / f_px)
 */
export function solveHfovFromReference(m: FaceMeasurement, cam: CameraModel, measuredDistanceM: number): number {
  const { ipdPx, v } = eyeGeometry(m);
  const ipd = cam.ipdMm / 1000;
  const p = (cam.pitchDeg * Math.PI) / 180;
  const yc = ((v - m.imageHeight / 2) * ipd) / ipdPx;
  const zc = (measuredDistanceM - cam.position.z + yc * Math.sin(p)) / Math.cos(p);
  if (!(zc > 0)) throw new Error('Measured distance must be in front of the webcam');
  const f = (zc * ipdPx) / ipd;
  return (2 * Math.atan(m.imageWidth / 2 / f) * 180) / Math.PI;
}

/**
 * Two-distance extrinsic + intrinsic calibration: given two measurements taken at roughly the
 * same eye height at two distinct distances (d1M != d2M), solves for both the webcam's downward
 * pitch angle (degrees) and horizontal field of view (degrees).
 */
export function solvePitchAndHfovFromTwoPoses(
  m1: FaceMeasurement,
  d1M: number,
  m2: FaceMeasurement,
  d2M: number,
  cam: CameraModel,
): { pitchDeg: number; hfovDeg: number } {
  if (Math.abs(d2M - d1M) < 0.05) {
    throw new Error('Two reference distances must differ by at least 5 cm');
  }
  const ipd = cam.ipdMm / 1000;
  const g1 = eyeGeometry(m1);
  const g2 = eyeGeometry(m2);
  const yc1 = ((g1.v - m1.imageHeight / 2) * ipd) / g1.ipdPx;
  const yc2 = ((g2.v - m2.imageHeight / 2) * ipd) / g2.ipdPx;
  // At constant world eye height (dy_world = 0), dYc = -(d2 - d1) * sin(pitch)
  const sinP = Math.min(0.7, Math.max(-0.7, -(yc2 - yc1) / (d2M - d1M)));
  const pitchDeg = (Math.asin(sinP) * 180) / Math.PI;
  const updatedCam: CameraModel = { ...cam, pitchDeg };
  const hfov1 = solveHfovFromReference(m1, updatedCam, d1M);
  const hfov2 = solveHfovFromReference(m2, updatedCam, d2M);
  return { pitchDeg, hfovDeg: (hfov1 + hfov2) / 2 };
}

/**
 * Average several measurements (reference capture) to reduce landmark noise.
 * Returns null if the list is empty.
 */
export function averageMeasurements(ms: FaceMeasurement[]): FaceMeasurement | null {
  if (!ms.length) return null;
  const a: FaceMeasurement = {
    t: ms[ms.length - 1].t,
    imageWidth: ms[0].imageWidth,
    imageHeight: ms[0].imageHeight,
    rightEye: { x: 0, y: 0 },
    leftEye: { x: 0, y: 0 },
    foreshortening: 0,
  };
  let ax = 0, ay = 0, az = 0, hasAxis = false;
  for (const m of ms) {
    a.rightEye.x += m.rightEye.x / ms.length;
    a.rightEye.y += m.rightEye.y / ms.length;
    a.leftEye.x += m.leftEye.x / ms.length;
    a.leftEye.y += m.leftEye.y / ms.length;
    a.foreshortening += m.foreshortening / ms.length;
    if (m.eyeAxis) {
      hasAxis = true;
      ax += m.eyeAxis.x;
      ay += m.eyeAxis.y;
      az += m.eyeAxis.z;
    }
  }
  if (hasAxis) {
    const len = Math.hypot(ax, ay, az) || 1;
    a.eyeAxis = v3(ax / len, ay / len, az / len);
  }
  return a;
}

/**
 * Foreshortening of the inter-eye axis from MediaPipe's facial transformation matrix
 * (column-major 4x4, face model -> camera). The face's x axis is the first column; only its
 * component in the image plane is visible.
 */
export function foreshorteningFromMatrix(data: ArrayLike<number> | undefined): number {
  if (!data || data.length < 16) return 1;
  const n = Math.hypot(data[0], data[1], data[2]);
  return n > 0 ? Math.hypot(data[0], data[1]) / n : 1;
}

/**
 * Extract the 3D unit vector of the inter-eye axis in camera coordinates (+x right, +y down, +z forward)
 * from MediaPipe's column-major 4x4 facial transformation matrix (which uses OpenGL camera coords:
 * +x right, +y up, -z forward).
 */
export function eyeAxisFromMatrix(data: ArrayLike<number> | undefined): Vec3 | undefined {
  if (!data || data.length < 16) return undefined;
  const n = Math.hypot(data[0], data[1], data[2]);
  if (!(n > 0)) return undefined;
  return v3(data[0] / n, -data[1] / n, -data[2] / n);
}

/** MediaPipe Face Mesh landmark indices of the eye corners and iris centres. */
export const EYE_LANDMARKS = {
  rightOuter: 33,
  rightInner: 133,
  leftInner: 362,
  leftOuter: 263,
  rightIris: 468,
  leftIris: 473,
} as const;
