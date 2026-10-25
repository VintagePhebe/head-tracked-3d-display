/**
 * Scene 2 — Depth Calibration.
 *
 * Precision metric environment for verifying off-axis perspective geometry:
 *  - Screen-plane frame at z = 0 with 5 cm tick marks around the monitor perimeter
 *  - Rectangular wireframe tunnel from z = 0 to z = -100 cm in 10 cm depth slices
 *  - Crisp metric depth labels (-10 cm, -20 cm, -30 cm, -50 cm, -75 cm, -100 cm)
 *  - Central sight-alignment rings: concentric when the eye is at (0, 0, D), shifting
 *    proportionally with lateral head movement
 *  - Reference objects at known physical sizes and distances
 */
import * as THREE from 'three';
import { buildScreenOutline, disposeObject, type VirtualScene } from './sceneTypes';

function makeLabelSprite(text: string, colorHex: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  ctx.strokeStyle = colorHex;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(4, 4, 248, 56, 10);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = colorHex;
  ctx.font = 'bold 28px ui-monospace, SFMono-Regular, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 33);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.08, 0.02, 1);
  return sprite;
}

export class CalibrationScene implements VirtualScene {
  readonly scene = new THREE.Scene();
  private root = new THREE.Group();
  private screenFrame: THREE.LineLoop | null = null;
  private frameVisible = true;
  private widthM = 0.531;
  private heightM = 0.299;

  constructor(widthM: number, heightM: number) {
    this.scene.background = new THREE.Color(0x070b12);
    this.scene.add(this.root);
    this.setScreenSize(widthM, heightM);
  }

  setScreenSize(widthM: number, heightM: number): void {
    this.widthM = widthM;
    this.heightM = heightM;
    this.rebuild();
  }

  setScreenFrameVisible(visible: boolean): void {
    this.frameVisible = visible;
    if (this.screenFrame) this.screenFrame.visible = visible;
  }

  private rebuild(): void {
    disposeObject(this.root);
    this.root.clear();

    const w = this.widthM;
    const h = this.heightM;
    const hw = w / 2;
    const hh = h / 2;
    const maxDepth = 1.0; // 100 cm metric tunnel

    // 1. Depth-slice rectangles every 10 cm from z = 0 to z = -1.0 m
    const sliceVerts: number[] = [];
    const majorVerts: number[] = [];
    for (let cm = 0; cm <= 100; cm += 10) {
      const z = -cm / 100;
      const target = cm % 50 === 0 ? majorVerts : sliceVerts;
      target.push(
        -hw, -hh, z,  hw, -hh, z,
         hw, -hh, z,  hw,  hh, z,
         hw,  hh, z, -hw,  hh, z,
        -hw,  hh, z, -hw, -hh, z,
      );
    }

    // Corner & midpoint depth rails from z = 0 to z = -1.0 m
    for (const x of [-hw, -hw / 2, 0, hw / 2, hw]) {
      for (const y of [-hh, hh]) {
        sliceVerts.push(x, y, 0, x, y, -maxDepth);
      }
    }
    for (const y of [-hh / 2, 0, hh / 2]) {
      for (const x of [-hw, hw]) {
        sliceVerts.push(x, y, 0, x, y, -maxDepth);
      }
    }

    // 5 cm physical ruler ticks on the z = 0 screen border
    const tickLen = 0.008;
    for (let x = -Math.floor(hw * 20) / 20; x <= hw + 1e-6; x += 0.05) {
      majorVerts.push(x, -hh, 0, x, -hh + tickLen, 0);
      majorVerts.push(x, hh, 0, x, hh - tickLen, 0);
    }
    for (let y = -Math.floor(hh * 20) / 20; y <= hh + 1e-6; y += 0.05) {
      majorVerts.push(-hw, y, 0, -hw + tickLen, y, 0);
      majorVerts.push(hw, y, 0, hw - tickLen, y, 0);
    }

    const addLines = (verts: number[], color: number, opacity = 1) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      const m = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
      this.root.add(new THREE.LineSegments(g, m));
    };
    addLines(sliceVerts, 0x1e3a5f, 0.85);
    addLines(majorVerts, 0x38bdf8, 1.0);

    // 2. Central sight-alignment crosshair & concentric rings at known depths
    // When the viewer's eye is centered at (0, 0, D), all rings align concentrically.
    const axisVerts = [
      0, 0, 0, 0, 0, -maxDepth,
      -0.04, 0, 0, 0.04, 0, 0,
      0, -0.04, 0, 0, 0.04, 0,
    ];
    addLines(axisVerts, 0xf59e0b, 0.9);

    const ringDepthsCm = [10, 20, 30, 50, 75, 100];
    const ringColors = ['#22d3ee', '#38bdf8', '#818cf8', '#a855f7', '#f472b6', '#fb923c'];
    ringDepthsCm.forEach((cm, idx) => {
      const z = -cm / 100;
      const color = new THREE.Color(ringColors[idx]);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.032, 0.035, 48),
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
      );
      ring.position.set(0, 0, z);
      this.root.add(ring);

      const label = makeLabelSprite(`-${cm} cm`, ringColors[idx]);
      label.position.set(-hw + 0.055, hh - 0.025 - idx * 0.032, z);
      this.root.add(label);
    });

    const screenLabel = makeLabelSprite('0 cm (SCREEN)', '#38bdf8');
    screenLabel.position.set(0, hh - 0.018, 0);
    this.root.add(screenLabel);

    // 3. Physical reference objects of exact metric dimensions
    const hemi = new THREE.HemisphereLight(0xe0f2fe, 0x0f172a, 0.9);
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(0.3, 0.5, 0.6);
    this.root.add(hemi, dir);

    // 6 cm reference cube at z = -20 cm (bottom-left quadrant)
    const cube20 = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.06, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x22c55e, roughness: 0.35, metalness: 0.2 }),
    );
    cube20.position.set(-w * 0.22, -h * 0.2, -0.2);
    this.root.add(cube20);

    // 6 cm reference cube at z = -50 cm (bottom-right quadrant)
    const cube50 = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.06, 0.06),
      new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.35, metalness: 0.2 }),
    );
    cube50.position.set(w * 0.22, -h * 0.2, -0.5);
    this.root.add(cube50);

    // 4 cm sphere right behind the screen glass at z = -6 cm (upper-right)
    const sphere6 = new THREE.Mesh(
      new THREE.SphereGeometry(0.02, 24, 24),
      new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.2, metalness: 0.6 }),
    );
    sphere6.position.set(w * 0.2, h * 0.2, -0.06);
    this.root.add(sphere6);

    this.screenFrame = buildScreenOutline(w, h, 0x38bdf8);
    this.screenFrame.visible = this.frameVisible;
    this.root.add(this.screenFrame);
  }

  update(): void {
    // Static precision geometry — no animation so measurements remain rock-solid.
  }

  dispose(): void {
    disposeObject(this.root);
  }
}
