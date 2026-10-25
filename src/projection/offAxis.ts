/**
 * Generalized off-axis ("head-coupled") perspective projection.
 *
 * Implements Robert Kooima's "Generalized Perspective Projection" (2008):
 * the physical screen is a fixed rectangle in world space, the eye is an arbitrary point
 * in front of it, and the frustum is the pyramid from the eye through the four physical
 * screen edges. Pure math — no rendering-engine dependency — so it can be unit-tested.
 *
 * World coordinate system (metres):
 *   origin = centre of the visible image area of the monitor
 *   +X = right (as seen by the viewer), +Y = up, +Z = out of the screen towards the viewer
 *   The screen lies in z = 0; the virtual world extends to z < 0.
 *
 * All matrices are 4x4, column-major (OpenGL / three.js convention).
 */

export type Vec3 = { x: number; y: number; z: number };
export type Mat4 = Float64Array; // length 16, column-major

/** Screen rectangle defined by three corners (lower-left, lower-right, upper-left). */
export interface ScreenRect {
  pa: Vec3; // lower-left
  pb: Vec3; // lower-right
  pc: Vec3; // upper-left
}

export interface OffAxisResult {
  /** Frustum extents on the near plane (eye space). */
  left: number;
  right: number;
  bottom: number;
  top: number;
  near: number;
  far: number;
  /** Perpendicular distance from the eye to the screen plane. */
  distance: number;
  /** Orthonormal screen basis: right, up, normal (normal points towards the viewer). */
  vr: Vec3;
  vu: Vec3;
  vn: Vec3;
  eye: Vec3;
  /** Projection matrix P (frustum). */
  projection: Mat4;
  /** View matrix V = M^T * T(-eye): world -> eye space. */
  view: Mat4;
}

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z);
  return v3(a.x / l, a.y / l, a.z / l);
};

/** Axis-aligned screen of the given physical size centred at the origin in the z=0 plane. */
export function centeredScreen(width: number, height: number): ScreenRect {
  return {
    pa: v3(-width / 2, -height / 2, 0),
    pb: v3(width / 2, -height / 2, 0),
    pc: v3(-width / 2, height / 2, 0),
  };
}

/** Sub-rectangle of the z=0 plane given by its min/max corners (e.g. a non-fullscreen canvas). */
export function rectScreen(x0: number, y0: number, x1: number, y1: number): ScreenRect {
  return { pa: v3(x0, y0, 0), pb: v3(x1, y0, 0), pc: v3(x0, y1, 0) };
}

/** Standard OpenGL frustum matrix (column-major), identical to glFrustum. */
export function frustumMatrix(
  l: number, r: number, b: number, t: number, n: number, f: number,
  out: Mat4 = new Float64Array(16),
): Mat4 {
  out.fill(0);
  out[0] = (2 * n) / (r - l);
  out[5] = (2 * n) / (t - b);
  out[8] = (r + l) / (r - l);
  out[9] = (t + b) / (t - b);
  out[10] = -(f + n) / (f - n);
  out[11] = -1;
  out[14] = (-2 * f * n) / (f - n);
  return out;
}

/** Minimum eye-to-screen distance accepted by the math (metres). */
export const MIN_EYE_DISTANCE = 1e-3;

/**
 * Compute the off-axis projection for an eye position and a physical screen rectangle.
 * The eye must be in front of the screen (on the side of the normal); otherwise the
 * distance is clamped to MIN_EYE_DISTANCE to keep the matrix finite.
 */
export function computeOffAxis(
  screen: ScreenRect, eye: Vec3, near: number, far: number,
  out?: OffAxisResult, // optional: reuse matrices (avoids per-frame Float64Array allocation)
): OffAxisResult {
  const { pa, pb, pc } = screen;
  const vr = normalize(sub(pb, pa));
  const vu = normalize(sub(pc, pa));
  const vn = normalize(cross(vr, vu));

  const va = sub(pa, eye);
  const vb = sub(pb, eye);
  const vc = sub(pc, eye);

  const distance = Math.max(-dot(va, vn), MIN_EYE_DISTANCE);
  const s = near / distance;
  const left = dot(vr, va) * s;
  const right = dot(vr, vb) * s;
  const bottom = dot(vu, va) * s;
  const top = dot(vu, vc) * s;

  const projection = frustumMatrix(left, right, bottom, top, near, far, out?.projection);

  // View = M^T * T(-eye), where M has columns (vr, vu, vn). M^T rows are vr, vu, vn.
  const view = out?.view ?? new Float64Array(16);
  view.fill(0);
  view[0] = vr.x; view[4] = vr.y; view[8] = vr.z;
  view[1] = vu.x; view[5] = vu.y; view[9] = vu.z;
  view[2] = vn.x; view[6] = vn.y; view[10] = vn.z;
  view[12] = -dot(vr, eye);
  view[13] = -dot(vu, eye);
  view[14] = -dot(vn, eye);
  view[15] = 1;

  const r = out ?? ({} as OffAxisResult);
  Object.assign(r, { left, right, bottom, top, near, far, distance, vr, vu, vn, projection, view });
  r.eye = { x: eye.x, y: eye.y, z: eye.z };
  return r;
}

/** Multiply a column-major 4x4 matrix by (x,y,z,1). Returns [x,y,z,w]. */
export function transformPoint(m: Mat4, p: Vec3): [number, number, number, number] {
  return [
    m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
    m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15],
  ];
}

/** Project a world point to normalized device coordinates using P * V. */
export function projectToNdc(r: OffAxisResult, p: Vec3): Vec3 {
  const [ex, ey, ez] = transformPoint(r.view, p);
  const [cx, cy, cz, cw] = transformPoint(r.projection, v3(ex, ey, ez));
  return v3(cx / cw, cy / cw, cz / cw);
}

/**
 * Reference geometry, independent of matrices: where on the screen plane z=0 does the ray
 * eye -> p cross it? Used to validate the projection (and for the debug overlay).
 */
export function rayScreenIntersection(eye: Vec3, p: Vec3): Vec3 {
  const t = eye.z / (eye.z - p.z);
  return v3(eye.x + (p.x - eye.x) * t, eye.y + (p.y - eye.y) * t, 0);
}
