/**
 * Scene 1 — The Virtual Room.
 *
 * A modern, stylized architectural studio room extending directly behind the monitor plane
 * (z = 0). The room's front opening matches the exact physical width and height of the
 * monitor so its four walls anchor to the four physical edges of the display.
 *
 * Objects are placed across 6 distinct depth layers (z = -0.05 m to -D) to produce clear,
 * continuous motion parallax as the viewer moves their head.
 */
import * as THREE from 'three';
import type { DesktopSurfaceSpec, DisplayBounds } from '../desktop/desktopCoordinates';
import { DesktopSurface3D, type DesktopSurfaceConfig } from '../desktop/desktopSurface3D';
import { buildScreenOutline, disposeObject, type VirtualScene } from './sceneTypes';

interface AnimatedItem {
  mesh: THREE.Object3D;
  baseY: number;
  ampY: number;
  speedY: number;
  rotX: number;
  rotY: number;
  phase: number;
}

function makePlankTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#2b211b';
  ctx.fillRect(0, 0, 512, 512);
  const planks = 8;
  const pw = 512 / planks;
  for (let i = 0; i < planks; i++) {
    const shade = 34 + ((i * 17) % 14);
    ctx.fillStyle = `rgb(${shade + 12}, ${shade + 2}, ${shade - 6})`;
    ctx.fillRect(i * pw + 1, 0, pw - 2, 512);
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillRect(i * pw, 0, 2, 512);
    const seamY = ((i * 137) % 380) + 60;
    ctx.fillRect(i * pw, seamY, pw, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeWallArtTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 512, 256);
  grad.addColorStop(0, '#0f172a');
  grad.addColorStop(0.5, '#1e293b');
  grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 256);

  // Concentric geometric sunrise motif
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 3;
  for (let r = 24; r <= 120; r += 24) {
    ctx.beginPath();
    ctx.arc(170, 140, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.arc(355, 115, 48, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(40, 195);
  ctx.lineTo(472, 195);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class VirtualRoomScene implements VirtualScene {
  readonly scene = new THREE.Scene();
  readonly desktopSurface = new DesktopSurface3D();
  private root = new THREE.Group();
  private classicDecor = new THREE.Group();
  private screenFrame: THREE.LineLoop | null = null;
  private frameVisible = false;
  private animated: AnimatedItem[] = [];
  private widthM = 0.531;
  private heightM = 0.299;
  private desktopEnabled = true;
  private desktopDepthM = 0.7;

  constructor(widthM: number, heightM: number) {
    this.scene.background = new THREE.Color(0x0b0f17);
    this.scene.add(this.root);
    this.scene.add(this.desktopSurface.group);
    this.setScreenSize(widthM, heightM);
  }

  setScreenSize(widthM: number, heightM: number): void {
    this.widthM = widthM;
    this.heightM = heightM;
    this.rebuild();
  }

  configureDesktop(cfg: DesktopSurfaceConfig, display: DisplayBounds): DesktopSurfaceSpec {
    const needRebuild =
      cfg.enabled !== this.desktopEnabled ||
      (cfg.enabled && Math.abs(cfg.depthM - this.desktopDepthM) > 0.002);
    this.desktopEnabled = cfg.enabled;
    this.desktopDepthM = cfg.depthM;
    if (needRebuild) {
      this.rebuild();
    }
    if (this.classicDecor) {
      this.classicDecor.visible = !cfg.enabled;
    }
    return this.desktopSurface.updateLayout(this.widthM, this.heightM, cfg, display);
  }

  setScreenFrameVisible(visible: boolean): void {
    this.frameVisible = visible;
    if (this.screenFrame) this.screenFrame.visible = visible;
  }

  private rebuild(): void {
    disposeObject(this.root);
    this.root.clear();
    this.classicDecor = new THREE.Group();
    this.animated = [];

    const w = this.widthM;
    const h = this.heightM;
    // When the 3D desktop is mounted on the back wall, anchor the back wall directly behind it;
    // otherwise scale depth with monitor width (~1.35x width).
    const d = this.desktopEnabled
      ? Math.max(0.2, this.desktopDepthM + 0.008)
      : Math.max(0.48, w * 1.35);
    const hw = w / 2;
    const hh = h / 2;

    // 1. Structural shell (begins exactly at z = 0, no front wall)
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1e2533, roughness: 0.82, metalness: 0.06 });
    const backWallMat = new THREE.MeshStandardMaterial({ color: 0x171d29, roughness: 0.78, metalness: 0.08 });
    const ceilMat = new THREE.MeshStandardMaterial({ color: 0x141923, roughness: 0.9, metalness: 0.04 });
    const floorMat = new THREE.MeshStandardMaterial({
      map: makePlankTexture(),
      roughness: 0.65,
      metalness: 0.05,
    });

    const addPlane = (pw: number, ph: number, mat: THREE.Material, pos: [number, number, number], rot: [number, number, number], receiveShadow = true) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), mat);
      m.position.set(...pos);
      m.rotation.set(...rot);
      m.receiveShadow = receiveShadow;
      this.root.add(m);
      return m;
    };

    // Left wall (x = -hw, normal +X), Right wall (x = +hw, normal -X)
    addPlane(d, h, wallMat, [-hw, 0, -d / 2], [0, Math.PI / 2, 0]);
    addPlane(d, h, wallMat, [hw, 0, -d / 2], [0, -Math.PI / 2, 0]);
    // Floor (y = -hh, normal +Y), Ceiling (y = +hh, normal -Y)
    addPlane(w, d, floorMat, [0, -hh, -d / 2], [-Math.PI / 2, 0, 0]);
    addPlane(w, d, ceilMat, [0, hh, -d / 2], [Math.PI / 2, 0, 0]);
    // Back wall (z = -d, normal +Z)
    addPlane(w, h, backWallMat, [0, 0, -d], [0, 0, 0]);

    // Architectural depth ribs along walls (every 20% of depth) so perspective lines lock to the monitor bezel
    const ribMat = new THREE.MeshStandardMaterial({ color: 0x2b3548, roughness: 0.5, metalness: 0.3 });
    const trimThick = Math.min(w, h) * 0.012;
    const ribCount = 5;
    for (let i = 0; i <= ribCount; i++) {
      const z = -(d * i) / ribCount - (i === 0 ? trimThick / 2 : 0);
      // Left & right vertical pilasters
      for (const sx of [-1, 1]) {
        const vBar = new THREE.Mesh(new THREE.BoxGeometry(trimThick, h, trimThick), ribMat);
        vBar.position.set(sx * (hw - trimThick / 2), 0, z);
        vBar.receiveShadow = true;
        this.root.add(vBar);
      }
      // Top & bottom horizontal beams
      for (const sy of [-1, 1]) {
        const hBar = new THREE.Mesh(new THREE.BoxGeometry(w, trimThick, trimThick), ribMat);
        hBar.position.set(0, sy * (hh - trimThick / 2), z);
        this.root.add(hBar);
      }
    }

    // Subtle emissive LED cove strips along top left/right ceiling edges
    const ledMat = new THREE.MeshBasicMaterial({ color: 0x7dd3fc });
    for (const sx of [-1, 1]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(trimThick * 0.6, trimThick * 0.4, d * 0.92), ledMat);
      strip.position.set(sx * (hw - trimThick * 1.4), hh - trimThick * 0.6, -d / 2);
      this.root.add(strip);
    }

    // 2. Lighting
    const hemi = new THREE.HemisphereLight(0xdbeafe, 0x3b2f2f, 0.65);
    this.root.add(hemi);

    const keyLight = new THREE.SpotLight(0xfff3da, 2.4, d * 3, Math.PI * 0.48, 0.45, 1.4);
    keyLight.position.set(w * 0.12, hh * 0.92, -d * 0.28);
    keyLight.target.position.set(0, -hh * 0.4, -d * 0.62);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.bias = -0.0005;
    this.root.add(keyLight, keyLight.target);

    const fillLight = new THREE.PointLight(0x38bdf8, 0.75, d * 2.2, 1.5);
    fillLight.position.set(-w * 0.32, hh * 0.5, -d * 0.22);
    this.root.add(fillLight);

    // 3. Back-wall framed artwork (shown when 3D Desktop back wall is disabled)
    this.classicDecor.visible = !this.desktopEnabled;
    this.root.add(this.classicDecor);

    const artW = w * 0.46;
    const artH = h * 0.36;
    const artY = hh * 0.22;
    const frameMesh = new THREE.Mesh(
      new THREE.BoxGeometry(artW + 0.016, artH + 0.016, 0.012),
      new THREE.MeshStandardMaterial({ color: 0x0f141c, roughness: 0.4, metalness: 0.6 }),
    );
    frameMesh.position.set(0, artY, -d + 0.008);
    frameMesh.castShadow = true;
    this.classicDecor.add(frameMesh);

    const canvasMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(artW, artH),
      new THREE.MeshStandardMaterial({ map: makeWallArtTexture(), roughness: 0.5 }),
    );
    canvasMesh.position.set(0, artY, -d + 0.015);
    this.classicDecor.add(canvasMesh);

    // 4. Desk / console table in the mid-to-back zone (lowered when back-wall desktop is active)
    const deskW = w * 0.58;
    const deskD = d * 0.24;
    const deskH = this.desktopEnabled ? h * 0.12 : h * 0.34;
    const deskZ = -d * 0.72;
    const deskTopY = -hh + deskH;
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x6e472b, roughness: 0.55, metalness: 0.08 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.35, metalness: 0.8 });

    const deskTop = new THREE.Mesh(new THREE.BoxGeometry(deskW, 0.014, deskD), woodMat);
    deskTop.position.set(0, deskTopY, deskZ);
    deskTop.castShadow = true;
    deskTop.receiveShadow = true;
    this.root.add(deskTop);

    const legGeo = new THREE.CylinderGeometry(0.007, 0.007, deskH, 12);
    for (const lx of [-deskW * 0.45, deskW * 0.45]) {
      for (const lz of [-deskD * 0.4, deskD * 0.4]) {
        const leg = new THREE.Mesh(legGeo, darkMetal);
        leg.position.set(lx, -hh + deskH / 2, deskZ + lz);
        leg.castShadow = true;
        this.root.add(leg);
      }
    }

    // Ultrawide curved-style monitor on the desk (hidden when back-wall desktop is active)
    const monW = deskW * 0.48;
    const monH = h * 0.24;
    const monStand = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.018, monH * 0.55, 16), darkMetal);
    monStand.position.set(0, deskTopY + monH * 0.25, deskZ - deskD * 0.18);
    this.classicDecor.add(monStand);

    const monBody = new THREE.Mesh(new THREE.BoxGeometry(monW, monH, 0.01), darkMetal);
    monBody.position.set(0, deskTopY + monH * 0.68, deskZ - deskD * 0.12);
    monBody.castShadow = true;
    this.classicDecor.add(monBody);

    const monScreen = new THREE.Mesh(
      new THREE.PlaneGeometry(monW * 0.94, monH * 0.88),
      new THREE.MeshStandardMaterial({
        color: 0x0ea5e9,
        emissive: 0x0284c7,
        emissiveIntensity: 0.65,
        roughness: 0.2,
      }),
    );
    monScreen.position.set(0, deskTopY + monH * 0.68, deskZ - deskD * 0.12 + 0.006);
    this.classicDecor.add(monScreen);

    // Articulated desk lamp on right side of desk
    const lampX = deskW * 0.34;
    const lampZ = deskZ + deskD * 0.1;
    const lampBase = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.008, 20), darkMetal);
    lampBase.position.set(lampX, deskTopY + 0.008, lampZ);
    this.root.add(lampBase);

    const lampStem = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, h * 0.26, 10), darkMetal);
    lampStem.position.set(lampX, deskTopY + h * 0.13, lampZ);
    lampStem.rotation.z = 0.22;
    this.root.add(lampStem);

    const lampHead = new THREE.Mesh(
      new THREE.ConeGeometry(0.024, 0.036, 20, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.35, metalness: 0.5, side: THREE.DoubleSide }),
    );
    lampHead.position.set(lampX - 0.022, deskTopY + h * 0.25, lampZ + 0.01);
    lampHead.rotation.z = 0.45;
    this.root.add(lampHead);

    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.009, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xfef08a }),
    );
    bulb.position.copy(lampHead.position).add(new THREE.Vector3(-0.004, -0.008, 0));
    this.root.add(bulb);

    const lampLight = new THREE.PointLight(0xfde68a, 0.9, d * 0.9, 1.8);
    lampLight.position.copy(bulb.position);
    this.root.add(lampLight);

    // Ceramic mug on left of desk
    const mug = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.012, 0.032, 18),
      new THREE.MeshStandardMaterial({ color: 0xf43f5e, roughness: 0.25, metalness: 0.1 }),
    );
    mug.position.set(-deskW * 0.3, deskTopY + 0.022, deskZ + deskD * 0.18);
    mug.castShadow = true;
    this.root.add(mug);

    // 5. Side-wall shelves at staggered depths (strong lateral parallax cues)
    const shelfBookColors = [0x38bdf8, 0xf97316, 0xa855f7, 0x22c55e, 0xeab308, 0xec4899];
    const addShelfUnit = (side: -1 | 1, yFrac: number, zFrac: number) => {
      const sw = w * 0.14;
      const sd = d * 0.22;
      const sx = side * (hw - sw / 2 - 0.004);
      const sy = yFrac * hh;
      const sz = -zFrac * d;
      const board = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.009, sd), woodMat);
      board.position.set(sx, sy, sz);
      board.castShadow = true;
      board.receiveShadow = true;
      this.root.add(board);

      // Books standing on the shelf
      for (let b = 0; b < 5; b++) {
        const bh = 0.038 + ((b * 7) % 14) * 0.0012;
        const bt = 0.009;
        const book = new THREE.Mesh(
          new THREE.BoxGeometry(sw * 0.72, bh, bt),
          new THREE.MeshStandardMaterial({
            color: shelfBookColors[(b + (side > 0 ? 2 : 0)) % shelfBookColors.length],
            roughness: 0.55,
          }),
        );
        book.position.set(sx, sy + 0.005 + bh / 2, sz - sd * 0.3 + b * (bt + 0.003));
        book.castShadow = true;
        this.root.add(book);
      }
    };
    addShelfUnit(-1, 0.18, 0.28);
    addShelfUnit(-1, -0.18, 0.54);
    addShelfUnit(1, 0.05, 0.38);

    // 6. Foreground & Midground Floating Sculptures (z = -0.12 d, -0.28 d, -0.45 d)
    // Placed close to the monitor plane so small head movements cause large relative shifts
    // against the distant desk and back wall.
    const addFloating = (
      geom: THREE.BufferGeometry,
      color: number,
      emissive: number,
      pos: [number, number, number],
      phase: number,
    ) => {
      const group = new THREE.Group();
      group.position.set(...pos);

      const core = new THREE.Mesh(
        geom,
        new THREE.MeshStandardMaterial({
          color,
          emissive,
          emissiveIntensity: 0.25,
          roughness: 0.2,
          metalness: 0.75,
        }),
      );
      core.castShadow = true;
      group.add(core);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(Math.min(w, h) * 0.075, 0.0022, 12, 48),
        new THREE.MeshStandardMaterial({
          color: 0xe2e8f0,
          emissive,
          emissiveIntensity: 0.55,
          roughness: 0.15,
          metalness: 0.9,
        }),
      );
      ring.rotation.x = Math.PI * 0.35;
      group.add(ring);

      // Thin vertical suspension tether to ceiling so its exact depth plane is visually anchored
      const tetherLen = hh - pos[1];
      const tether = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0008, 0.0008, tetherLen, 6),
        new THREE.MeshBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.45 }),
      );
      tether.position.set(pos[0], pos[1] + tetherLen / 2, pos[2]);
      this.root.add(tether);

      this.root.add(group);
      this.animated.push({
        mesh: core,
        baseY: pos[1],
        ampY: 0.004,
        speedY: 1.4,
        rotX: 0.45,
        rotY: 0.7,
        phase,
      });
    };

    const rScale = Math.min(w, h);
    const fx = this.desktopEnabled ? 0.39 : 0.22;
    // Near foreground sculpture (just 14% of room depth behind the screen glass!)
    addFloating(
      new THREE.OctahedronGeometry(rScale * 0.046, 0),
      0x38bdf8,
      0x0284c7,
      [-w * fx, h * 0.26, -d * 0.14],
      0,
    );
    // Right midground icosahedron (30% of room depth)
    addFloating(
      new THREE.IcosahedronGeometry(rScale * 0.05, 0),
      0xf59e0b,
      0xd97706,
      [w * fx, -h * 0.22, -d * 0.3],
      2.1,
    );
    if (!this.desktopEnabled) {
      // Deep midground torus knot (48% of room depth)
      addFloating(
        new THREE.TorusKnotGeometry(rScale * 0.038, rScale * 0.011, 64, 12),
        0xa855f7,
        0x7e22ce,
        [-w * 0.04, h * 0.2, -d * 0.48],
        4.2,
      );
    }

    // 7. Floor planter in front-right corner (z = -0.22 d)
    const potH = h * 0.16;
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.026, 0.02, potH, 20),
      new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.4 }),
    );
    pot.position.set(w * 0.34, -hh + potH / 2, -d * 0.22);
    pot.castShadow = true;
    this.root.add(pot);

    const foliage = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.032, 1),
      new THREE.MeshStandardMaterial({ color: 0x10b981, roughness: 0.65 }),
    );
    foliage.position.set(w * 0.34, -hh + potH + 0.022, -d * 0.22);
    foliage.castShadow = true;
    this.root.add(foliage);

    this.screenFrame = buildScreenOutline(w, h);
    this.screenFrame.visible = this.frameVisible;
    this.root.add(this.screenFrame);
  }

  update(dtS: number, elapsedS: number): void {
    for (let i = 0; i < this.animated.length; i++) {
      const a = this.animated[i];
      a.mesh.rotation.x += a.rotX * dtS;
      a.mesh.rotation.y += a.rotY * dtS;
      if (a.mesh.parent) {
        a.mesh.parent.position.y = a.baseY + Math.sin(elapsedS * a.speedY + a.phase) * a.ampY;
      }
    }
  }

  dispose(): void {
    disposeObject(this.root);
    this.desktopSurface.dispose();
  }
}
