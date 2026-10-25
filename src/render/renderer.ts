/**
 * Three.js WebGL rendering engine + virtual off-axis camera wrapper.
 *
 * Applies the generalized off-axis projection (`OffAxisResult`) directly to a Three.js
 * camera without modifying `camera.rotation` via `lookAt` (which would falsely rotate the
 * screen plane). All matrix updates are in-place with zero per-frame allocations.
 */
import * as THREE from 'three';
import type { Quality } from '../config/config';
import { computeOffAxis, type OffAxisResult, type ScreenRect, type Vec3 } from '../projection/offAxis';

const NEAR_PLANE = 0.02; // 2 cm
const FAR_PLANE = 25.0; // 25 m

export class OffAxisRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly lastProjection: OffAxisResult;

  private quality: Quality = 'medium';

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(45, 1, NEAR_PLANE, FAR_PLANE);
    this.camera.matrixAutoUpdate = false;

    // Pre-allocate projection output object so `computeOffAxis` never allocates in the loop.
    this.lastProjection = computeOffAxis(
      { pa: { x: -0.25, y: -0.15, z: 0 }, pb: { x: 0.25, y: -0.15, z: 0 }, pc: { x: -0.25, y: 0.15, z: 0 } },
      { x: 0, y: 0, z: 0.6 },
      NEAR_PLANE,
      FAR_PLANE,
    );
    this.applyQuality('medium');
    this.resize();
  }

  applyQuality(q: Quality): void {
    this.quality = q;
    const dpr = window.devicePixelRatio || 1;
    const maxDpr = q === 'low' ? 1.0 : q === 'medium' ? 1.5 : 2.0;
    this.renderer.setPixelRatio(Math.min(dpr, maxDpr));
    this.renderer.shadowMap.enabled = q !== 'low';
    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
  }

  /**
   * Update the virtual camera's view and projection matrices from the physical screen
   * rectangle and the current eye position (both in world metres).
   */
  updateCamera(screen: ScreenRect, eye: Vec3): OffAxisResult {
    const r = computeOffAxis(screen, eye, NEAR_PLANE, FAR_PLANE, this.lastProjection);
    const pElem = this.camera.projectionMatrix.elements;
    const vElem = this.camera.matrixWorldInverse.elements;
    for (let i = 0; i < 16; i++) {
      pElem[i] = r.projection[i];
      vElem[i] = r.view[i];
    }
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.camera.matrixWorld.copy(this.camera.matrixWorldInverse).invert();
    this.camera.position.set(eye.x, eye.y, eye.z);
    return r;
  }

  render(scene: THREE.Scene): void {
    this.renderer.render(scene, this.camera);
  }

  /**
   * Render a stereoscopic Red/Cyan anaglyph pair using two asymmetric off-axis frusta
   * (one for the physical left eye, one for the physical right eye) anchored to the exact
   * same physical screen rectangle.
   */
  renderAnaglyph(scene: THREE.Scene, screen: ScreenRect, leftEye: Vec3, rightEye: Vec3): void {
    const gl = this.renderer.getContext();
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;

    this.renderer.clear(true, true, true);

    // Left eye -> Red channel
    this.updateCamera(screen, leftEye);
    gl.colorMask(true, false, false, true);
    this.renderer.render(scene, this.camera);

    this.renderer.clearDepth();

    // Right eye -> Cyan (Green + Blue) channels
    this.updateCamera(screen, rightEye);
    gl.colorMask(false, true, true, true);
    this.renderer.render(scene, this.camera);

    gl.colorMask(true, true, true, true);
    this.renderer.autoClear = prevAutoClear;
  }

  getQuality(): Quality {
    return this.quality;
  }
}
