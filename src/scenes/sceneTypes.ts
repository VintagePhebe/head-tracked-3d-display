import * as THREE from 'three';

export interface VirtualScene {
  readonly scene: THREE.Scene;
  /** Rebuild or rescale geometry so the front opening matches the physical monitor (metres). */
  setScreenSize(widthM: number, heightM: number): void;
  /** Toggle a highlighted outline right on the z = 0 screen plane for debugging. */
  setScreenFrameVisible(visible: boolean): void;
  /** Per-frame animation hook (must not allocate). */
  update(dtS: number, elapsedS: number): void;
  dispose(): void;
}

/** Build a rectangular line loop on z = 0 outlining the physical screen boundaries. */
export function buildScreenOutline(w: number, h: number, color = 0x38bdf8): THREE.LineLoop {
  const hw = w / 2;
  const hh = h / 2;
  const pts = new Float32Array([
    -hw, -hh, 0,
     hw, -hh, 0,
     hw,  hh, 0,
    -hw,  hh, 0,
  ]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });
  const loop = new THREE.LineLoop(geom, mat);
  loop.renderOrder = 999;
  return loop;
}

/** Recursively dispose geometries, materials and textures in a group. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const g = (obj as THREE.Mesh).geometry;
    if (g) g.dispose();
    const m = (obj as THREE.Mesh).material;
    const disposeMat = (mat: THREE.Material) => {
      for (const v of Object.values(mat)) {
        if (v && typeof v === 'object' && 'isTexture' in v) (v as THREE.Texture).dispose();
      }
      mat.dispose();
    };
    if (Array.isArray(m)) m.forEach(disposeMat);
    else if (m) disposeMat(m);
  });
}
