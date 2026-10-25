/**
 * Scene 3 — Floating Objects.
 *
 * A dark, high-contrast chamber containing geometric sculptures suspended across 9 depth
 * planes (from z = -0.04 m right behind the glass down to z = -1.4 m), connected to a
 * subtle boundary frame at z = 0. Designed to isolate and maximize motion parallax.
 */
import * as THREE from 'three';
import { buildScreenOutline, disposeObject, type VirtualScene } from './sceneTypes';

interface Floater {
  mesh: THREE.Object3D;
  rx: number;
  ry: number;
  baseY: number;
  phase: number;
}

export class FloatingObjectsScene implements VirtualScene {
  readonly scene = new THREE.Scene();
  private root = new THREE.Group();
  private screenFrame: THREE.LineLoop | null = null;
  private frameVisible = false;
  private floaters: Floater[] = [];
  private widthM = 0.531;
  private heightM = 0.299;

  constructor(widthM: number, heightM: number) {
    this.scene.background = new THREE.Color(0x05070c);
    this.scene.fog = new THREE.FogExp2(0x05070c, 0.45);
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
    this.floaters = [];

    const w = this.widthM;
    const h = this.heightM;
    const hw = w / 2;
    const hh = h / 2;
    const maxD = 1.4;

    // 1. Subtle dark tunnel rails anchored at the z = 0 screen edges
    const railVerts: number[] = [];
    const steps = 7;
    for (let i = 0; i <= steps; i++) {
      const z = -(maxD * i) / steps;
      railVerts.push(
        -hw, -hh, z,  hw, -hh, z,
         hw, -hh, z,  hw,  hh, z,
         hw,  hh, z, -hw,  hh, z,
        -hw,  hh, z, -hw, -hh, z,
      );
    }
    for (const sx of [-hw, hw]) {
      for (const sy of [-hh, hh]) {
        railVerts.push(sx, sy, 0, sx, sy, -maxD);
      }
    }
    const railGeom = new THREE.BufferGeometry();
    railGeom.setAttribute('position', new THREE.Float32BufferAttribute(railVerts, 3));
    this.root.add(new THREE.LineSegments(railGeom, new THREE.LineBasicMaterial({ color: 0x1e293b })));

    // 2. Lighting with strong specular highlights for contrasting materials
    this.root.add(new THREE.HemisphereLight(0x93c5fd, 0x090d16, 0.55));

    const key = new THREE.DirectionalLight(0xfff7ed, 2.0);
    key.position.set(0.4, 0.5, 0.5);
    this.root.add(key);

    const rim = new THREE.PointLight(0x38bdf8, 1.8, 2.5, 1.4);
    rim.position.set(-w * 0.4, h * 0.35, -0.25);
    this.root.add(rim);

    const warm = new THREE.PointLight(0xf97316, 1.5, 2.5, 1.4);
    warm.position.set(w * 0.4, -h * 0.3, -0.65);
    this.root.add(warm);

    // 3. Layered floating geometric objects from z = -0.045 m to z = -1.25 m
    const r = Math.min(w, h);
    const specs: Array<{
      geom: THREE.BufferGeometry;
      pos: [number, number, number];
      color: number;
      emissive?: number;
      metalness: number;
      roughness: number;
    }> = [
      // Very near plane (z = -4.5 cm): barely moves on screen when head moves
      {
        geom: new THREE.TorusGeometry(r * 0.055, r * 0.012, 20, 48),
        pos: [0, 0, -0.045],
        color: 0x38bdf8,
        emissive: 0x0284c7,
        metalness: 0.85,
        roughness: 0.15,
      },
      // Foreground left & right (z = -12 cm, -18 cm)
      {
        geom: new THREE.OctahedronGeometry(r * 0.06, 0),
        pos: [-w * 0.26, h * 0.18, -0.12],
        color: 0xf59e0b,
        metalness: 0.9,
        roughness: 0.2,
      },
      {
        geom: new THREE.IcosahedronGeometry(r * 0.055, 0),
        pos: [w * 0.25, -h * 0.16, -0.18],
        color: 0xec4899,
        metalness: 0.35,
        roughness: 0.25,
      },
      // Midground cluster (z = -28 cm .. -52 cm)
      {
        geom: new THREE.TorusKnotGeometry(r * 0.05, r * 0.014, 72, 16),
        pos: [w * 0.14, h * 0.2, -0.28],
        color: 0xa855f7,
        emissive: 0x581c87,
        metalness: 0.75,
        roughness: 0.2,
      },
      {
        geom: new THREE.DodecahedronGeometry(r * 0.065, 0),
        pos: [-w * 0.18, -h * 0.2, -0.38],
        color: 0x10b981,
        metalness: 0.4,
        roughness: 0.3,
      },
      {
        geom: new THREE.BoxGeometry(r * 0.085, r * 0.085, r * 0.085),
        pos: [0, h * 0.04, -0.5],
        color: 0xe2e8f0,
        metalness: 0.92,
        roughness: 0.12,
      },
      // Deep layers (z = -70 cm .. -120 cm): exhibit large apparent screen motion
      {
        geom: new THREE.ConeGeometry(r * 0.065, r * 0.13, 6),
        pos: [-w * 0.24, h * 0.08, -0.7],
        color: 0x06b6d4,
        metalness: 0.65,
        roughness: 0.22,
      },
      {
        geom: new THREE.SphereGeometry(r * 0.07, 32, 32),
        pos: [w * 0.22, -h * 0.08, -0.92],
        color: 0xf97316,
        emissive: 0x7c2d12,
        metalness: 0.8,
        roughness: 0.18,
      },
      {
        geom: new THREE.TorusGeometry(r * 0.12, r * 0.015, 20, 64),
        pos: [0, -h * 0.05, -1.2],
        color: 0x60a5fa,
        emissive: 0x1d4ed8,
        metalness: 0.85,
        roughness: 0.15,
      },
    ];

    specs.forEach((s, i) => {
      const mat = new THREE.MeshStandardMaterial({
        color: s.color,
        emissive: s.emissive ?? 0x000000,
        emissiveIntensity: s.emissive ? 0.4 : 0,
        metalness: s.metalness,
        roughness: s.roughness,
      });
      const mesh = new THREE.Mesh(s.geom, mat);
      mesh.position.set(...s.pos);
      this.root.add(mesh);

      // Subtle anchor stem down to floor plane so the viewer can also read exact depth on the floor rail
      const stemH = s.pos[1] - -hh;
      if (stemH > 0.01) {
        const stem = new THREE.Mesh(
          new THREE.CylinderGeometry(0.0007, 0.0007, stemH, 6),
          new THREE.MeshBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.55 }),
        );
        stem.position.set(s.pos[0], -hh + stemH / 2, s.pos[2]);
        this.root.add(stem);
      }

      this.floaters.push({
        mesh,
        rx: (i % 2 === 0 ? 1 : -1) * (0.25 + (i % 3) * 0.12),
        ry: (i % 2 === 0 ? -1 : 1) * (0.35 + (i % 4) * 0.1),
        baseY: s.pos[1],
        phase: i * 1.1,
      });
    });

    this.screenFrame = buildScreenOutline(w, h);
    this.screenFrame.visible = this.frameVisible;
    this.root.add(this.screenFrame);
  }

  update(dtS: number, elapsedS: number): void {
    for (let i = 0; i < this.floaters.length; i++) {
      const f = this.floaters[i];
      f.mesh.rotation.x += f.rx * dtS;
      f.mesh.rotation.y += f.ry * dtS;
      f.mesh.position.y = f.baseY + Math.sin(elapsedS * 1.3 + f.phase) * 0.0035;
    }
  }

  dispose(): void {
    disposeObject(this.root);
  }
}
