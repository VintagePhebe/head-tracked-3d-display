import { describe, expect, it } from 'vitest';
import {
  centeredScreen, computeOffAxis, projectToNdc, rayScreenIntersection, rectScreen, transformPoint, v3,
  type Vec3,
} from '../src/projection/offAxis';

// A 27" 16:9 monitor: 59.8 x 33.6 cm visible area.
const W = 0.598;
const H = 0.336;
const screen = centeredScreen(W, H);
const NEAR = 0.01;
const FAR = 100;

/** Convert a point on the screen plane to the NDC it must occupy (fixed physical mapping). */
const screenPointToNdc = (p: Vec3) => v3((2 * p.x) / W, (2 * p.y) / H, 0);

const eyes: Vec3[] = [
  v3(0, 0, 0.6),
  v3(-0.25, 0.1, 0.45),
  v3(0.4, -0.2, 0.8),
  v3(0.05, 0.3, 0.25),
  v3(-0.6, -0.4, 1.5),
  v3(1.2, 0.0, 0.3), // eye far outside the screen's lateral extent
];

describe('off-axis projection: screen anchoring', () => {
  it('maps the four physical screen corners to the NDC corners for every eye position', () => {
    for (const e of eyes) {
      const r = computeOffAxis(screen, e, NEAR, FAR);
      const corners: [Vec3, number, number][] = [
        [v3(-W / 2, -H / 2, 0), -1, -1],
        [v3(W / 2, -H / 2, 0), 1, -1],
        [v3(-W / 2, H / 2, 0), -1, 1],
        [v3(W / 2, H / 2, 0), 1, 1],
      ];
      for (const [p, nx, ny] of corners) {
        const ndc = projectToNdc(r, p);
        expect(ndc.x).toBeCloseTo(nx, 10);
        expect(ndc.y).toBeCloseTo(ny, 10);
      }
    }
  });

  it('keeps any point lying on the screen plane at a fixed screen location (no sliding)', () => {
    const pts = [v3(0, 0, 0), v3(0.1, -0.05, 0), v3(-0.2, 0.15, 0), v3(0.29, 0.16, 0)];
    for (const p of pts) {
      const expected = screenPointToNdc(p);
      for (const e of eyes) {
        const ndc = projectToNdc(computeOffAxis(screen, e, NEAR, FAR), p);
        expect(ndc.x).toBeCloseTo(expected.x, 10);
        expect(ndc.y).toBeCloseTo(expected.y, 10);
      }
    }
  });
});

describe('off-axis projection: agreement with ray/plane geometry', () => {
  it('projects points behind the screen exactly where the eye ray crosses the screen', () => {
    const pts = [v3(0, 0, -0.5), v3(0.2, -0.1, -0.3), v3(-0.4, 0.3, -2), v3(0.05, 0.02, -10), v3(0.1, 0.1, 0.1)];
    for (const e of eyes) {
      const r = computeOffAxis(screen, e, NEAR, FAR);
      for (const p of pts) {
        const hit = rayScreenIntersection(e, p);
        const ndc = projectToNdc(r, p);
        const exp = screenPointToNdc(hit);
        expect(ndc.x).toBeCloseTo(exp.x, 9);
        expect(ndc.y).toBeCloseTo(exp.y, 9);
      }
    }
  });

  it('matches a hand-computed example', () => {
    // Eye 10 cm left of centre at 50 cm. Point at back of a 50 cm deep box, centre.
    // Ray crosses z=0 at x = -0.1 + (0 - -0.1) * 0.5/(0.5+0.5) = -0.05 m -> NDC = -0.05 / (W/2)
    const r = computeOffAxis(screen, v3(-0.1, 0, 0.5), NEAR, FAR);
    const ndc = projectToNdc(r, v3(0, 0, -0.5));
    expect(ndc.x).toBeCloseTo(-0.05 / (W / 2), 12);
    expect(ndc.y).toBeCloseTo(0, 12);
    // Frustum extents: left = (-W/2 + 0.1) * n/d, right = (W/2 + 0.1) * n/d
    expect(r.left).toBeCloseTo(((-W / 2 + 0.1) * NEAR) / 0.5, 12);
    expect(r.right).toBeCloseTo(((W / 2 + 0.1) * NEAR) / 0.5, 12);
    expect(r.distance).toBeCloseTo(0.5, 12);
  });

  it('produces depth values in (-1, 1) between near and far, increasing with distance', () => {
    const r = computeOffAxis(screen, v3(0, 0, 0.6), NEAR, FAR);
    const z1 = projectToNdc(r, v3(0, 0, -0.1)).z;
    const z2 = projectToNdc(r, v3(0, 0, -1)).z;
    const z3 = projectToNdc(r, v3(0, 0, -50)).z;
    expect(z1).toBeGreaterThan(-1);
    expect(z3).toBeLessThan(1);
    expect(z1).toBeLessThan(z2);
    expect(z2).toBeLessThan(z3);
  });
});

describe('off-axis projection: motion parallax directions', () => {
  const backPoint = v3(0, 0, -0.5);

  it('head moves left -> distant content shifts left on screen (reveals more of the right side)', () => {
    const c = projectToNdc(computeOffAxis(screen, v3(0, 0, 0.6), NEAR, FAR), backPoint);
    const l = projectToNdc(computeOffAxis(screen, v3(-0.15, 0, 0.6), NEAR, FAR), backPoint);
    expect(l.x).toBeLessThan(c.x);
    // the right wall's far edge (x=W/2, z=-0.5) moves inward => more of the right wall is visible
    const rightWallBack = v3(W / 2, 0, -0.5);
    const rC = projectToNdc(computeOffAxis(screen, v3(0, 0, 0.6), NEAR, FAR), rightWallBack);
    const rL = projectToNdc(computeOffAxis(screen, v3(-0.15, 0, 0.6), NEAR, FAR), rightWallBack);
    expect(rL.x).toBeLessThan(rC.x);
  });

  it('head moves right -> distant content shifts right (reveals more of the left side)', () => {
    const c = projectToNdc(computeOffAxis(screen, v3(0, 0, 0.6), NEAR, FAR), backPoint);
    const r = projectToNdc(computeOffAxis(screen, v3(0.15, 0, 0.6), NEAR, FAR), backPoint);
    expect(r.x).toBeGreaterThan(c.x);
  });

  it('head moves up -> distant content shifts up (reveals more of the floor)', () => {
    const c = projectToNdc(computeOffAxis(screen, v3(0, 0, 0.6), NEAR, FAR), backPoint);
    const u = projectToNdc(computeOffAxis(screen, v3(0, 0.1, 0.6), NEAR, FAR), backPoint);
    expect(u.y).toBeGreaterThan(c.y);
    const floorBack = v3(0, -H / 2, -0.5);
    const fC = projectToNdc(computeOffAxis(screen, v3(0, 0, 0.6), NEAR, FAR), floorBack);
    const fU = projectToNdc(computeOffAxis(screen, v3(0, 0.1, 0.6), NEAR, FAR), floorBack);
    expect(fU.y).toBeGreaterThan(fC.y); // floor/back-wall seam rises => more floor visible
  });

  it('head moves down -> distant content shifts down (reveals more of the ceiling)', () => {
    const c = projectToNdc(computeOffAxis(screen, v3(0, 0, 0.6), NEAR, FAR), backPoint);
    const d = projectToNdc(computeOffAxis(screen, v3(0, -0.1, 0.6), NEAR, FAR), backPoint);
    expect(d.y).toBeLessThan(c.y);
  });

  it('nearer objects move less on screen than farther ones for the same head motion (screen-anchored parallax)', () => {
    const e0 = v3(0, 0, 0.6);
    const e1 = v3(0.1, 0, 0.6);
    const shift = (p: Vec3) =>
      projectToNdc(computeOffAxis(screen, e1, NEAR, FAR), p).x - projectToNdc(computeOffAxis(screen, e0, NEAR, FAR), p).x;
    const sPlane = shift(v3(0, 0, 0));
    const sNear = shift(v3(0, 0, -0.1));
    const sFar = shift(v3(0, 0, -1));
    const sVeryFar = shift(v3(0, 0, -100));
    expect(sPlane).toBeCloseTo(0, 12);
    expect(sNear).toBeGreaterThan(0);
    expect(sFar).toBeGreaterThan(sNear);
    expect(sVeryFar).toBeGreaterThan(sFar);
    // Objects at infinity move with the head exactly: shift on screen = head shift.
    expect(sVeryFar * (W / 2)).toBeCloseTo(0.1 * (100 / 100.6), 6);
  });
});

describe('off-axis projection: viewing distance', () => {
  it('moving closer widens the field of view through the same physical opening', () => {
    const near = computeOffAxis(screen, v3(0, 0, 0.3), NEAR, FAR);
    const far = computeOffAxis(screen, v3(0, 0, 1.2), NEAR, FAR);
    const fovNear = 2 * Math.atan(near.right / NEAR);
    const fovFar = 2 * Math.atan(far.right / NEAR);
    expect(fovNear).toBeGreaterThan(fovFar);
    expect(Math.tan(fovNear / 2)).toBeCloseTo(W / 2 / 0.3, 12);
    expect(Math.tan(fovFar / 2)).toBeCloseTo(W / 2 / 1.2, 12);
  });

  it('moving closer makes the back wall appear smaller and the side walls longer', () => {
    const backCorner = v3(W / 2, H / 2, -0.5);
    const close = projectToNdc(computeOffAxis(screen, v3(0, 0, 0.3), NEAR, FAR), backCorner);
    const away = projectToNdc(computeOffAxis(screen, v3(0, 0, 1.2), NEAR, FAR), backCorner);
    // back corner NDC = (W/2) * d/(d+0.5) / (W/2)
    expect(close.x).toBeCloseTo(0.3 / 0.8, 12);
    expect(away.x).toBeCloseTo(1.2 / 1.7, 12);
    expect(close.x).toBeLessThan(away.x);
  });
});

describe('off-axis projection: orientation (no spurious rotation)', () => {
  it('the view rotation is identity for an axis-aligned screen regardless of eye position', () => {
    for (const e of eyes) {
      const r = computeOffAxis(screen, e, NEAR, FAR);
      const m = r.view;
      const rot = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
      expect(rot.map((x) => Math.round(x * 1e12) / 1e12)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
      // translation = -eye
      expect(m[12]).toBeCloseTo(-e.x, 12);
      expect(m[13]).toBeCloseTo(-e.y, 12);
      expect(m[14]).toBeCloseTo(-e.z, 12);
    }
  });

  it('lines parallel to the screen stay parallel to the screen edges (horizontals stay horizontal)', () => {
    for (const e of eyes) {
      const r = computeOffAxis(screen, e, NEAR, FAR);
      const a = projectToNdc(r, v3(-0.2, 0.05, -0.7));
      const b = projectToNdc(r, v3(0.2, 0.05, -0.7));
      expect(a.y).toBeCloseTo(b.y, 12);
      const c = projectToNdc(r, v3(0.1, -0.1, -0.4));
      const d = projectToNdc(r, v3(0.1, 0.1, -0.4));
      expect(c.x).toBeCloseTo(d.x, 12);
    }
  });
});

describe('off-axis projection: general screens', () => {
  it('handles an off-centre sub-rectangle (windowed canvas) with exact corner mapping', () => {
    const sub = rectScreen(-0.1, -0.05, 0.2, 0.12);
    const e = v3(0.3, -0.1, 0.5);
    const r = computeOffAxis(sub, e, NEAR, FAR);
    expect(projectToNdc(r, v3(-0.1, -0.05, 0)).x).toBeCloseTo(-1, 10);
    expect(projectToNdc(r, v3(0.2, 0.12, 0)).y).toBeCloseTo(1, 10);
    const p = v3(0.05, 0.0, -0.6);
    const hit = rayScreenIntersection(e, p);
    const ndc = projectToNdc(r, p);
    expect(ndc.x).toBeCloseTo((2 * (hit.x + 0.1)) / 0.3 - 1, 10);
    expect(ndc.y).toBeCloseTo((2 * (hit.y + 0.05)) / 0.17 - 1, 10);
  });

  it('handles a rotated (tilted) screen: corners still map to NDC corners', () => {
    const a = (30 * Math.PI) / 180;
    const rot = (p: Vec3) => v3(p.x * Math.cos(a) + p.z * Math.sin(a), p.y, -p.x * Math.sin(a) + p.z * Math.cos(a));
    const s = { pa: rot(v3(-W / 2, -H / 2, 0)), pb: rot(v3(W / 2, -H / 2, 0)), pc: rot(v3(-W / 2, H / 2, 0)) };
    const pd = rot(v3(W / 2, H / 2, 0));
    const e = rot(v3(0.1, 0.05, 0.6));
    const r = computeOffAxis(s, e, NEAR, FAR);
    const ndc = projectToNdc(r, pd);
    expect(ndc.x).toBeCloseTo(1, 10);
    expect(ndc.y).toBeCloseTo(1, 10);
    expect(r.distance).toBeCloseTo(0.6, 10);
  });

  it('stays finite when the eye reaches the screen plane', () => {
    const r = computeOffAxis(screen, v3(0, 0, 0), NEAR, FAR);
    for (const x of r.projection) expect(Number.isFinite(x)).toBe(true);
    const [, , , w] = transformPoint(r.projection, v3(0, 0, -1));
    expect(w).toBe(1);
  });
});
