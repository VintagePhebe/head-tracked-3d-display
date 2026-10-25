/**
 * Mouse-controlled eye-position simulator.
 *
 * Maps pointer position on the canvas and wheel scroll to a physical 3D eye coordinate
 * in metres relative to the screen centre, using the exact same coordinate system and
 * off-axis projection pipeline as webcam head tracking.
 *
 * Controls:
 *  - Move cursor over canvas (or drag when `dragOnly` is false/true): horizontal & vertical eye offset
 *  - Mouse wheel: change viewing distance Z (15 cm .. 200 cm)
 *  - Double-click canvas: reset to default central eye position
 */
import type { Vec3 } from '../projection/offAxis';

export class MouseSimulator {
  private target: Vec3;
  private current: Vec3;
  private defaultZ: number;
  /** Maximum lateral excursion as a multiple of screen width/height. */
  lateralRangeM = { x: 0.45, y: 0.30 };
  minZ = 0.15;
  maxZ = 2.0;
  /**
   * When true (Mode A: Desktop Interaction active), normal pointer movement and wheel scroll
   * are routed to the 3D Windows Desktop; holding Alt + moving the mouse still simulates head movement.
   */
  desktopInteractionActive = false;

  constructor(defaultDistanceM: number) {
    this.defaultZ = defaultDistanceM;
    this.target = { x: 0, y: 0, z: defaultDistanceM };
    this.current = { x: 0, y: 0, z: defaultDistanceM };
  }

  setDefaultDistance(dM: number): void {
    const atDefault = Math.abs(this.target.z - this.defaultZ) < 1e-3;
    this.defaultZ = dM;
    if (atDefault) {
      this.target.z = dM;
      this.current.z = dM;
    }
  }

  reset(): void {
    this.target.x = 0;
    this.target.y = 0;
    this.target.z = this.defaultZ;
  }

  /** Set exact simulated eye position (metres) — also used by automated tests. */
  setEye(x: number, y: number, z: number, immediate = false): void {
    this.target.x = x;
    this.target.y = y;
    this.target.z = Math.min(this.maxZ, Math.max(this.minZ, z));
    if (immediate) {
      this.current.x = this.target.x;
      this.current.y = this.target.y;
      this.current.z = this.target.z;
    }
  }

  /** Attach pointer and wheel listeners to the rendering canvas. */
  attach(canvas: HTMLElement): () => void {
    const onMove = (e: PointerEvent) => {
      if (this.desktopInteractionActive && !e.altKey) return;
      const r = canvas.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1; // -1 .. +1
      const ny = 1 - ((e.clientY - r.top) / r.height) * 2; // -1 .. +1 (+Y up)
      this.target.x = nx * this.lateralRangeM.x;
      this.target.y = ny * this.lateralRangeM.y;
    };
    const onWheel = (e: WheelEvent) => {
      if (this.desktopInteractionActive && !e.altKey) return;
      e.preventDefault();
      const step = e.deltaY * 0.0004;
      this.target.z = Math.min(this.maxZ, Math.max(this.minZ, this.target.z + step));
    };
    const onDblClick = () => {
      if (this.desktopInteractionActive) return;
      this.reset();
    };

    canvas.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    return () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
    };
  }

  /** Advance smooth interpolation and write the eye position into `out`. */
  sample(dtS: number, gain: number, out: Vec3): void {
    const k = 1 - Math.exp(-Math.min(dtS, 0.1) * 22);
    this.current.x += (this.target.x * gain - this.current.x) * k;
    this.current.y += (this.target.y * gain - this.current.y) * k;
    this.current.z += (this.target.z - this.current.z) * k;
    out.x = this.current.x;
    out.y = this.current.y;
    out.z = this.current.z;
  }
}
