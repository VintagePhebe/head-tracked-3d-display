import { describe, expect, it } from 'vitest';
import {
  fitDesktopAspectRatio,
  projectDesktopPixelToNdc,
  raycastDesktopSurface,
  type DesktopSurfaceSpec,
} from '../src/desktop/desktopCoordinates';
import { centeredScreen, projectToNdc, computeOffAxis, v3 } from '../src/projection/offAxis';

const W = 0.531;
const H = 0.299;
const screen = centeredScreen(W, H);

const surface: DesktopSurfaceSpec = {
  centerX: 0,
  centerY: 0,
  depthM: 0.7,
  widthM: 0.48,
  heightM: 0.27,
  display: { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1.25 },
};

describe('desktop coordinate mapping & perspective raycasting', () => {
  it('preserves aspect ratio when fitting a desktop surface into the back wall', () => {
    const f1 = fitDesktopAspectRatio(0.5, 0.3, 1920, 1080);
    expect(f1.widthM / f1.heightM).toBeCloseTo(16 / 9, 9);
    expect(f1.widthM).toBeLessThanOrEqual(0.5);
    expect(f1.heightM).toBeLessThanOrEqual(0.3);

    const f2 = fitDesktopAspectRatio(0.5, 0.3, 3440, 1440);
    expect(f2.widthM / f2.heightM).toBeCloseTo(3440 / 1440, 9);
    expect(f2.widthM).toBeCloseTo(0.5, 9);
  });

  it('maps the centre of the screen to the centre of the desktop when eye is centered', () => {
    const hit = raycastDesktopSurface(v3(0, 0, 0.6), screen, 0, 0, surface)!;
    expect(hit.inside).toBe(true);
    expect(hit.u).toBeCloseTo(0.5, 9);
    expect(hit.v).toBeCloseTo(0.5, 9);
    expect(hit.desktopX).toBe(960);
    expect(hit.desktopY).toBe(540);
  });

  it('agrees identically with the off-axis projection matrix across arbitrary 3D eye positions', () => {
    const eyes = [
      v3(0, 0, 0.6),
      v3(-0.22, 0.08, 0.55),
      v3(0.18, -0.12, 0.75),
      v3(0.05, 0.15, 0.35),
      v3(-0.3, -0.1, 1.1),
    ];
    const pixels: [number, number][] = [
      [0, 0],
      [1919, 0],
      [0, 1079],
      [1919, 1079],
      [960, 540],
      [420, 315],
      [1510, 820],
    ];

    for (const eye of eyes) {
      const offAxis = computeOffAxis(screen, eye, 0.02, 25);
      for (const [px, py] of pixels) {
        // 1. Project the 3D desktop pixel onto the front window
        const proj = projectDesktopPixelToNdc(eye, screen, px, py, surface);
        // Verify that the off-axis projection matrix P*V places that 3D point at the exact same NDC!
        const matNdc = projectToNdc(offAxis, proj.worldPoint);
        expect(proj.ndcX).toBeCloseTo(matNdc.x, 9);
        expect(proj.ndcY).toBeCloseTo(matNdc.y, 9);

        // 2. Raycast from the cursor at (ndcX, ndcY) back onto the 3D desktop surface
        const hit = raycastDesktopSurface(eye, screen, proj.ndcX, proj.ndcY, surface)!;
        expect(hit.inside).toBe(true);
        expect(hit.desktopX).toBe(px);
        expect(hit.desktopY).toBe(py);
      }
    }
  });

  it('detects when a ray misses the desktop surface (hits surrounding room walls)', () => {
    const eye = v3(0, 0, 0.6);
    // Corner of the physical monitor projects beyond the 0.48 x 0.27 m back-wall desktop
    const hit = raycastDesktopSurface(eye, screen, 0.98, 0.98, surface)!;
    expect(hit.inside).toBe(false);
    expect(hit.rawU).toBeGreaterThan(1);
    expect(hit.rawV).toBeGreaterThan(1);
    // Clamped coordinates stay within valid display pixel bounds
    expect(hit.desktopX).toBe(1919);
    expect(hit.desktopY).toBe(0);
  });

  it('handles secondary displays with negative or offset virtual-screen coordinates', () => {
    const secondary: DesktopSurfaceSpec = {
      ...surface,
      centerX: 0.03,
      centerY: -0.02,
      display: { x: -2560, y: 0, width: 2560, height: 1440, scaleFactor: 1.5 },
    };
    const eye = v3(-0.1, 0.05, 0.65);
    const proj = projectDesktopPixelToNdc(eye, screen, -1280, 720, secondary);
    const hit = raycastDesktopSurface(eye, screen, proj.ndcX, proj.ndcY, secondary)!;
    expect(hit.inside).toBe(true);
    expect(hit.desktopX).toBe(-1280);
    expect(hit.desktopY).toBe(720);
  });

  it('shifts the raycasted desktop coordinate consistently as the user moves their head (parallax)', () => {
    // Fixed cursor at the center of the physical monitor window (ndcX = 0, ndcY = 0)
    const hitCenter = raycastDesktopSurface(v3(0, 0, 0.6), screen, 0, 0, surface)!;
    // When the viewer moves their head left (-X), looking through the center of the window (0,0,0)
    // points toward the right (+X) side of the back wall!
    const hitHeadLeft = raycastDesktopSurface(v3(-0.12, 0, 0.6), screen, 0, 0, surface)!;
    // When the viewer moves their head right (+X), looking through the center of the window (0,0,0)
    // points toward the left (-X) side of the back wall!
    const hitHeadRight = raycastDesktopSurface(v3(0.12, 0, 0.6), screen, 0, 0, surface)!;

    expect(hitHeadLeft.desktopX).toBeGreaterThan(hitCenter.desktopX);
    expect(hitHeadRight.desktopX).toBeLessThan(hitCenter.desktopX);
  });
});
