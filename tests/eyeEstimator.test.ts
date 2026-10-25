import { describe, expect, it } from 'vitest';
import {
  averageMeasurements, estimateEye, eyeAxisFromMatrix, focalPx, foreshorteningFromMatrix,
  selectTargetEye, solveHfovFromReference, solvePitchAndHfovFromTwoPoses, stereoEyePair,
  type CameraModel, type FaceMeasurement,
} from '../src/tracking/eyeEstimator';
import { v3, type Vec3 } from '../src/projection/offAxis';

const IMG_W = 1280;
const IMG_H = 720;

/** Forward model: render the eye corners of a head at world `eye` through the webcam. */
function synthesize(eye: Vec3, cam: CameraModel, yawDeg = 0): FaceMeasurement {
  const f = focalPx(IMG_W, cam.hfovDeg);
  const p = (cam.pitchDeg * Math.PI) / 180;
  const c = Math.cos(p), s = Math.sin(p);
  const ipd = cam.ipdMm / 1000;
  const yaw = (yawDeg * Math.PI) / 180;
  const toCam = (w: Vec3) => {
    const d = v3(w.x - cam.position.x, w.y - cam.position.y, w.z - cam.position.z);
    return v3(-d.x, -c * d.y - s * d.z, -s * d.y + c * d.z);
  };
  const project = (w: Vec3) => {
    const q = toCam(w);
    return { x: (IMG_W / 2 + (f * q.x) / q.z) / IMG_W, y: (IMG_H / 2 + (f * q.y) / q.z) / IMG_H };
  };
  // Viewer faces -Z, so the viewer's right is world +X.
  const half = v3((ipd / 2) * Math.cos(yaw), 0, (ipd / 2) * Math.sin(yaw));
  const rWorld = v3(eye.x + half.x, eye.y, eye.z + half.z);
  const lWorld = v3(eye.x - half.x, eye.y, eye.z - half.z);
  const rCam = toCam(rWorld);
  const lCam = toCam(lWorld);
  const axis = v3((lCam.x - rCam.x) / ipd, (lCam.y - rCam.y) / ipd, (lCam.z - rCam.z) / ipd);
  return {
    t: 0,
    imageWidth: IMG_W,
    imageHeight: IMG_H,
    rightEye: project(rWorld),
    leftEye: project(lWorld),
    foreshortening: Math.hypot(axis.x, axis.y),
    eyeAxis: axis,
  };
}

const camTop: CameraModel = { hfovDeg: 60, ipdMm: 63, position: v3(0, 0.18, 0), pitchDeg: 0 };

describe('eye estimator: pinhole back-projection', () => {
  const eyes = [v3(0, 0, 0.6), v3(-0.2, 0.05, 0.5), v3(0.15, -0.1, 0.9), v3(0.3, 0.2, 0.35)];
  const cams: CameraModel[] = [
    camTop,
    { hfovDeg: 75, ipdMm: 58, position: v3(0.12, 0.17, 0.01), pitchDeg: 0 },
    { hfovDeg: 55, ipdMm: 68, position: v3(-0.05, 0.19, 0.02), pitchDeg: 12 },
    { hfovDeg: 65, ipdMm: 63, position: v3(0, -0.2, 0), pitchDeg: -8 }, // bottom-mounted, tilted up
  ];

  it('recovers the exact world eye position from synthetic landmarks', () => {
    for (const cam of cams) {
      for (const e of eyes) {
        const est = estimateEye(synthesize(e, cam), cam);
        expect(est.eye.x).toBeCloseTo(e.x, 9);
        expect(est.eye.y).toBeCloseTo(e.y, 9);
        expect(est.eye.z).toBeCloseTo(e.z, 9);
      }
    }
  });

  it('maps image directions correctly (unmirrored camera faces the viewer)', () => {
    const left = synthesize(v3(-0.2, 0, 0.6), camTop); // viewer moves to their left (world -X)
    const right = synthesize(v3(0.2, 0, 0.6), camTop);
    // Moving to world -X appears on the image's right side (camera looks back at the viewer).
    expect(left.rightEye.x).toBeGreaterThan(right.rightEye.x);
    expect(estimateEye(left, camTop).eye.x).toBeLessThan(0);
    expect(estimateEye(right, camTop).eye.x).toBeGreaterThan(0);
  });

  it('does not treat the webcam as the screen centre', () => {
    // Eyes level with the screen centre, camera 18 cm above: face is low in the image,
    // but the estimate must still be y = 0.
    const m = synthesize(v3(0, 0, 0.6), camTop);
    expect(m.rightEye.y).toBeGreaterThan(0.5);
    expect(estimateEye(m, camTop).eye.y).toBeCloseTo(0, 9);
  });

  it('depth scales inversely with apparent eye separation', () => {
    const near = estimateEye(synthesize(v3(0, 0, 0.4), camTop), camTop);
    const far = estimateEye(synthesize(v3(0, 0, 0.8), camTop), camTop);
    expect(near.ipdPx / far.ipdPx).toBeCloseTo(2, 6);
  });

  it('compensates head yaw using the 3D eyeAxis and foreshortening factor', () => {
    const offAxisTruth = v3(0.08, -0.05, 0.6);
    const m = synthesize(offAxisTruth, camTop, 30);
    // With full 3D eyeAxis from facialTransformationMatrix: exact recovery even off-axis!
    const exactEst = estimateEye(m, camTop);
    expect(exactEst.eye.x).toBeCloseTo(offAxisTruth.x, 9);
    expect(exactEst.eye.y).toBeCloseTo(offAxisTruth.y, 9);
    expect(exactEst.eye.z).toBeCloseTo(offAxisTruth.z, 9);
    // Individual left and right eye 3D world positions are also recovered:
    expect(selectTargetEye(exactEst, 'left').x).toBeLessThan(exactEst.eye.x);
    expect(selectTargetEye(exactEst, 'right').x).toBeGreaterThan(exactEst.eye.x);

    // Without 3D eyeAxis (scalar foreshortening fallback) vs completely uncompensated:
    const scalarEst = estimateEye({ ...m, eyeAxis: undefined }, camTop).eye.z;
    const without = estimateEye({ ...m, eyeAxis: undefined, foreshortening: 1 }, camTop).eye.z;
    expect(Math.abs(scalarEst - offAxisTruth.z)).toBeLessThan(0.035);
    expect(without - offAxisTruth.z).toBeGreaterThan(0.07);
  });

  it('computes stereo eye pairs and extracts 3D eyeAxis from facial transformation matrix', () => {
    const pair = stereoEyePair(v3(0, 0, 0.6), 64);
    expect(pair.left.x).toBeCloseTo(-0.032, 9);
    expect(pair.right.x).toBeCloseTo(0.032, 9);

    const y = (20 * Math.PI) / 180;
    const m = [Math.cos(y), 0, -Math.sin(y), 0, 0, 1, 0, 0, Math.sin(y), 0, Math.cos(y), 0, 0, 0, -50, 1];
    const ax = eyeAxisFromMatrix(m)!;
    expect(ax.x).toBeCloseTo(Math.cos(y), 9);
    expect(ax.z).toBeCloseTo(Math.sin(y), 9);
  });

  it('solves both camera downward pitch and HFOV from two reference distances', () => {
    const truthCam: CameraModel = { ...camTop, pitchDeg: 11.5, hfovDeg: 68.4 };
    const m1 = synthesize(v3(0, -0.02, 0.48), truthCam);
    const m2 = synthesize(v3(0, -0.02, 0.78), truthCam);
    const guessCam: CameraModel = { ...camTop, pitchDeg: 0, hfovDeg: 60 };
    const solved = solvePitchAndHfovFromTwoPoses(m1, 0.48, m2, 0.78, guessCam);
    expect(solved.pitchDeg).toBeCloseTo(11.5, 5);
    expect(solved.hfovDeg).toBeCloseTo(68.4, 5);
  });
});

describe('eye estimator: reference calibration', () => {
  it('solves the true webcam FOV from one reference at a measured distance', () => {
    for (const trueFov of [52, 64, 78]) {
      for (const pitch of [0, 10]) {
        const truthCam = { ...camTop, hfovDeg: trueFov, pitchDeg: pitch };
        const m = synthesize(v3(0.03, -0.02, 0.65), truthCam);
        const guessCam = { ...truthCam, hfovDeg: 60 };
        expect(solveHfovFromReference(m, guessCam, 0.65)).toBeCloseTo(trueFov, 6);
      }
    }
  });

  it('after calibration, distances at other positions are estimated correctly', () => {
    const truthCam = { ...camTop, hfovDeg: 71 };
    const ref = synthesize(v3(0, 0, 0.6), truthCam);
    const hfov = solveHfovFromReference(ref, { ...truthCam, hfovDeg: 60 }, 0.6);
    const est = estimateEye(synthesize(v3(-0.1, 0.05, 0.9), truthCam), { ...truthCam, hfovDeg: hfov });
    expect(est.eye.z).toBeCloseTo(0.9, 6);
  });

  it('rejects impossible reference distances', () => {
    const m = synthesize(v3(0, 0, 0.6), camTop);
    expect(() => solveHfovFromReference(m, { ...camTop, position: v3(0, 0.18, 0.5) }, 0.3)).toThrow();
  });

  it('averages measurements', () => {
    const a = synthesize(v3(0, 0, 0.6), camTop);
    const b = synthesize(v3(0.02, 0, 0.6), camTop);
    const avg = averageMeasurements([a, b])!;
    expect(avg.rightEye.x).toBeCloseTo((a.rightEye.x + b.rightEye.x) / 2, 12);
    expect(averageMeasurements([])).toBeNull();
  });
});

describe('foreshortening from facial transformation matrix', () => {
  it('is cos(yaw) for a pure yaw rotation and 1 for identity / missing data', () => {
    const y = (25 * Math.PI) / 180;
    // column-major rotation about Y
    const m = [Math.cos(y), 0, -Math.sin(y), 0, 0, 1, 0, 0, Math.sin(y), 0, Math.cos(y), 0, 0, 0, -50, 1];
    expect(foreshorteningFromMatrix(m)).toBeCloseTo(Math.cos(y), 12);
    expect(foreshorteningFromMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBe(1);
    expect(foreshorteningFromMatrix(undefined)).toBe(1);
  });
});
