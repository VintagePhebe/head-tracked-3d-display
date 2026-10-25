/**
 * 3D Back-Wall Desktop Display Surface & Perspective-Aligned 3D Virtual Cursor.
 *
 * Mounts the captured live Windows desktop onto the back wall of the 3D virtual room
 * inside a framed ultra-thin monitor bezel, with an unlit high-clarity display material
 * (fog-free, toneMapped: false) so text and icons remain crisp under off-axis projection.
 */
import * as THREE from 'three';
import {
  fitDesktopAspectRatio,
  type DesktopSurfaceSpec,
  type DisplayBounds,
} from './desktopCoordinates';

export type CursorShape = 'arrow' | 'ibeam' | 'hand' | 'wait' | 'resize';

export interface DesktopSurfaceConfig {
  enabled: boolean;
  /** Perpendicular distance behind the monitor plane in world metres. */
  depthM: number;
  /** Width scale relative to the virtual room width (0.3 - 1.0). */
  widthScale: number;
  /** Height scale relative to the virtual room height (0.3 - 1.0). */
  heightScale: number;
  /** Horizontal offset from room center in world metres. */
  offsetXM: number;
  /** Vertical offset from room center in world metres. */
  offsetYM: number;
  /** Show the 3D virtual cursor on the desktop surface. */
  showCursor: boolean;
}

function createStandbyTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 576;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 1024, 576);
  grad.addColorStop(0, '#0a1222');
  grad.addColorStop(0.5, '#0f1c34');
  grad.addColorStop(1, '#08101e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1024, 576);

  ctx.strokeStyle = 'rgba(72, 184, 255, 0.16)';
  ctx.lineWidth = 1;
  for (let x = 64; x < 1024; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 576);
    ctx.stroke();
  }
  for (let y = 64; y < 576; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(1024, y);
    ctx.stroke();
  }

  ctx.fillStyle = '#e6f1ff';
  ctx.font = '600 32px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Windows 11 Live 3D Desktop Surface', 512, 260);

  ctx.fillStyle = '#7fa6cc';
  ctx.font = '400 20px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText('Connecting to live desktop capture stream...', 512, 305);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createCursorTexture(shape: CursorShape): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (shape === 'ibeam') {
    // Centered at (64, 64)
    ctx.strokeStyle = '#050811';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(46, 24);
    ctx.lineTo(82, 24);
    ctx.moveTo(64, 24);
    ctx.lineTo(64, 104);
    ctx.moveTo(46, 104);
    ctx.lineTo(82, 104);
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.stroke();
  } else if (shape === 'hand') {
    // Hotspot at top-left index finger (32, 16)
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#050811';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.roundRect(26, 14, 16, 54, 8);
    ctx.roundRect(42, 32, 15, 42, 7);
    ctx.roundRect(57, 36, 15, 40, 7);
    ctx.roundRect(72, 42, 14, 36, 7);
    ctx.roundRect(24, 52, 62, 46, 16);
    ctx.stroke();
    ctx.fill();
  } else if (shape === 'resize') {
    // Double arrow centered at (64, 64)
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#050811';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(18, 64);
    ctx.lineTo(42, 44);
    ctx.lineTo(42, 57);
    ctx.lineTo(86, 57);
    ctx.lineTo(86, 44);
    ctx.lineTo(110, 64);
    ctx.lineTo(86, 84);
    ctx.lineTo(86, 71);
    ctx.lineTo(42, 71);
    ctx.lineTo(42, 84);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
  } else {
    // High-contrast Windows 11 style arrow with hotspot near top-left (16, 16)
    ctx.beginPath();
    ctx.moveTo(16, 16);
    ctx.lineTo(16, 94);
    ctx.lineTo(38, 74);
    ctx.lineTo(54, 108);
    ctx.lineTo(68, 101);
    ctx.lineTo(52, 67);
    ctx.lineTo(80, 67);
    ctx.closePath();

    ctx.strokeStyle = '#050811';
    ctx.lineWidth = 9;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Subtle cyan highlight tip for visibility against both white and black desktops
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(20, 22, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class DesktopSurface3D {
  public readonly group = new THREE.Group();
  private screenMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private bezelMesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  private glowMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private cursorGroup = new THREE.Group();
  private cursorMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private clickRingMesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;

  private standbyTexture: THREE.CanvasTexture;
  private cursorTextures: Record<CursorShape, THREE.CanvasTexture>;
  private currentCursorShape: CursorShape = 'arrow';

  private spec: DesktopSurfaceSpec = {
    centerX: 0,
    centerY: 0,
    depthM: 0.7,
    widthM: 0.48,
    heightM: 0.27,
    display: { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 },
  };

  constructor() {
    this.group.name = 'DesktopSurface3D';
    this.standbyTexture = createStandbyTexture();
    this.cursorTextures = {
      arrow: createCursorTexture('arrow'),
      ibeam: createCursorTexture('ibeam'),
      hand: createCursorTexture('hand'),
      wait: createCursorTexture('arrow'),
      resize: createCursorTexture('resize'),
    };

    // 1. Subtle ambient backlight glow on the back wall behind the bezel
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      fog: false,
    });
    this.glowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMat);
    this.glowMesh.position.z = -0.006;
    this.group.add(this.glowMesh);

    // 2. Slim dark metallic monitor bezel
    const bezelMat = new THREE.MeshStandardMaterial({
      color: 0x101520,
      roughness: 0.4,
      metalness: 0.6,
    });
    this.bezelMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.008), bezelMat);
    this.bezelMesh.position.z = -0.0045;
    this.group.add(this.bezelMesh);

    // 3. Unlit, fog-free, non-tone-mapped desktop display surface for crisp text
    const screenMat = new THREE.MeshBasicMaterial({
      map: this.standbyTexture,
      toneMapped: false,
      fog: false,
    });
    this.screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), screenMat);
    this.screenMesh.position.z = 0;
    this.group.add(this.screenMesh);

    // 4. 3D Virtual Cursor mounted just in front of the desktop plane
    const cursorMat = new THREE.MeshBasicMaterial({
      map: this.cursorTextures.arrow,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.cursorMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), cursorMat);
    this.cursorMesh.renderOrder = 999;

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.clickRingMesh = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.48, 24), ringMat);
    this.clickRingMesh.renderOrder = 998;

    this.cursorGroup.add(this.clickRingMesh);
    this.cursorGroup.add(this.cursorMesh);
    this.cursorGroup.position.z = 0.0015;
    this.cursorGroup.visible = false;
    this.group.add(this.cursorGroup);
  }

  setLiveTexture(texture: THREE.Texture | null, isActive: boolean): void {
    const nextMap = isActive && texture ? texture : this.standbyTexture;
    if (this.screenMesh.material.map !== nextMap) {
      this.screenMesh.material.map = nextMap;
      this.screenMesh.material.needsUpdate = true;
    }
  }

  /**
   * Update the 3D surface layout on the virtual room's back wall.
   */
  updateLayout(
    roomWidthM: number,
    roomHeightM: number,
    cfg: DesktopSurfaceConfig,
    display: DisplayBounds,
  ): DesktopSurfaceSpec {
    this.group.visible = cfg.enabled;

    const maxW = Math.max(0.12, roomWidthM * cfg.widthScale);
    const maxH = Math.max(0.08, roomHeightM * cfg.heightScale);
    const fitted = fitDesktopAspectRatio(maxW, maxH, display.width, display.height);

    // Keep the surface slightly in front of the back wall plane so it never z-fights
    const depthM = Math.max(0.08, cfg.depthM);
    const centerX = cfg.offsetXM;
    const centerY = cfg.offsetYM;

    this.spec = {
      centerX,
      centerY,
      depthM,
      widthM: fitted.widthM,
      heightM: fitted.heightM,
      display,
    };

    this.group.position.set(centerX, centerY, -depthM);

    // Resize screen plane & bezel
    this.screenMesh.scale.set(fitted.widthM, fitted.heightM, 1);
    const bezelPad = 0.012;
    this.bezelMesh.scale.set(fitted.widthM + bezelPad, fitted.heightM + bezelPad, 1);
    this.glowMesh.scale.set(fitted.widthM + bezelPad * 3.2, fitted.heightM + bezelPad * 3.2, 1);

    // Scale virtual cursor proportionally to the virtual monitor height (~3.8% of screen height)
    const cursorSizeM = Math.max(0.011, Math.min(0.028, fitted.heightM * 0.045));
    this.cursorGroup.scale.set(cursorSizeM, cursorSizeM, 1);
    this.applyCursorHotspotOffset(this.currentCursorShape);

    return this.spec;
  }

  getSpec(): DesktopSurfaceSpec {
    return this.spec;
  }

  setCursorShape(shape: CursorShape): void {
    if (this.currentCursorShape === shape) return;
    this.currentCursorShape = shape;
    const tex = this.cursorTextures[shape] || this.cursorTextures.arrow;
    this.cursorMesh.material.map = tex;
    this.cursorMesh.material.needsUpdate = true;
    this.applyCursorHotspotOffset(shape);
  }

  private applyCursorHotspotOffset(shape: CursorShape): void {
    // Align the cursor mesh so its active hotspot sits at (0, 0) in cursorGroup local space
    if (shape === 'arrow' || shape === 'hand' || shape === 'wait') {
      this.cursorMesh.position.set(0.35, -0.35, 0);
    } else {
      this.cursorMesh.position.set(0, 0, 0);
    }
  }

  /**
   * Position the 3D virtual cursor at world intersection point `(wx, wy)` on the desktop plane,
   * strictly clamped to the virtual screen boundaries.
   */
  updateCursor(wx: number, wy: number, visible: boolean, pressed = false): void {
    this.cursorGroup.visible = visible && this.group.visible;
    if (!this.cursorGroup.visible) return;

    const hw = this.spec.widthM * 0.5;
    const hh = this.spec.heightM * 0.5;
    const localX = Math.min(hw, Math.max(-hw, wx - this.spec.centerX));
    const localY = Math.min(hh, Math.max(-hh, wy - this.spec.centerY));
    this.cursorGroup.position.set(localX, localY, 0.0015);
    this.clickRingMesh.material.opacity = pressed ? 0.85 : 0.0;
  }

  dispose(): void {
    this.standbyTexture.dispose();
    for (const tex of Object.values(this.cursorTextures)) {
      tex.dispose();
    }
    this.screenMesh.geometry.dispose();
    this.screenMesh.material.dispose();
    this.bezelMesh.geometry.dispose();
    this.bezelMesh.material.dispose();
    this.glowMesh.geometry.dispose();
    this.glowMesh.material.dispose();
    this.cursorMesh.geometry.dispose();
    this.cursorMesh.material.dispose();
    this.clickRingMesh.geometry.dispose();
    this.clickRingMesh.material.dispose();
  }
}
