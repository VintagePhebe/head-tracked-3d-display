# Virtual Window — Head-Tracked 3D Display

Transforms an ordinary 2D monitor and webcam into a head-coupled 3D virtual window using **generalized off-axis perspective projection** (Robert Kooima, 2008), real-time **MediaPipe Face Landmarker** tracking in a dedicated Web Worker, **One-Euro adaptive filtering**, and **Three.js WebGL** rendering.

---

## 1. Quick Start & Commands

### Prerequisites

- **OS**: Windows 11 (also compatible with macOS / Linux)
- **Node.js**: v20+ (tested on Node v22.16.0)
- **Hardware**: Standard monitor and webcam (mouse simulation mode works without a webcam)

### Installation

```powershell
npm install
```

`postinstall` automatically runs `scripts/setup-assets.mjs`, which copies the MediaPipe WASM runtime into `public/mediapipe/wasm/` and ensures `public/models/face_landmarker.task` is present so the application runs **100% offline** with no external CDN calls.

### Development (Browser)

```powershell
npm run dev
```

Open the printed local URL (`http://localhost:5173`) in Chromium/Edge/Chrome/Firefox.

### Development (Electron Desktop App)

```powershell
npm run electron:dev
```

### Production Build & Desktop Launch

```powershell
npm run build       # TypeScript type-check + Vite production bundle into dist/
npm run electron    # Build and launch the standalone Electron desktop window
npm run package     # Package a standalone Windows x64 desktop build in release/
```

### Automated Tests & End-to-End Smoke Verification

```powershell
npm test            # Run all Vitest mathematical, tracking, filter, and config unit tests
npm run smoke       # Build and run headless-style Electron WebGL + MediaPipe WASM verification
```

---

## 2. Architecture

The codebase is organized into 9 focused modules under `src/`:

| Module | Files | Responsibility |
|---|---|---|
| **1. Perspective Projection** | [`src/projection/offAxis.ts`](src/projection/offAxis.ts), [`src/projection/screenGeometry.ts`](src/projection/screenGeometry.ts) | Pure-math Kooima generalized asymmetric frustum (`computeOffAxis`) and physical screen-to-canvas mapping. Zero rendering engine dependencies. |
| **2. Head Tracking** | [`src/tracking/faceTracker.ts`](src/tracking/faceTracker.ts), [`src/tracking/detector.worker.ts`](src/tracking/detector.worker.ts), [`src/tracking/camera.ts`](src/tracking/camera.ts), [`src/tracking/protocol.ts`](src/tracking/protocol.ts) | `getUserMedia` capture, frame downscaling via `createImageBitmap`, off-main-thread MediaPipe Face Landmarker inference (GPU delegate with automatic CPU fallback), and structured camera error recovery. |
| **3. Eye Estimation** | [`src/tracking/eyeEstimator.ts`](src/tracking/eyeEstimator.ts) | Pinhole camera back-projection from 2D eye-corner landmarks + inter-pupillary distance (IPD) + 3D head-pose foreshortening correction, plus closed-form reference HFOV solver (`solveHfovFromReference`). |
| **4. Pose Filtering & Simulation** | [`src/tracking/oneEuro.ts`](src/tracking/oneEuro.ts), [`src/tracking/headPose.ts`](src/tracking/headPose.ts), [`src/tracking/mouseSim.ts`](src/tracking/mouseSim.ts) | Per-axis One-Euro filter, velocity-based latency extrapolation, graceful tracking-loss hold/return/recovery state machine, and mouse eye-position simulator. |
| **5. Rendering Engine** | [`src/render/renderer.ts`](src/render/renderer.ts) | Three.js WebGL renderer with ACES Filmic tone mapping, PCF soft shadows, quality tiers (`low`/`medium`/`high`), and direct in-place projection/view matrix updates (`matrixAutoUpdate = false`). |
| **6. 3D Environments** | [`src/scenes/virtualRoom.ts`](src/scenes/virtualRoom.ts), [`src/scenes/calibrationScene.ts`](src/scenes/calibrationScene.ts), [`src/scenes/floatingScene.ts`](src/scenes/floatingScene.ts), [`src/scenes/sceneManager.ts`](src/scenes/sceneManager.ts) | Three selectable 3D scenes whose front openings lock to the physical monitor dimensions $(W, H)$ on the $z = 0$ plane. |
| **7. Calibration System** | [`src/ui/calibrationWizard.ts`](src/ui/calibrationWizard.ts) | Guided 4-step wizard for physical screen size, webcam mount offsets, reference face capture, and live perspective verification. |
| **8. User Interface** | [`src/ui/hud.ts`](src/ui/hud.ts), [`src/styles.css`](src/styles.css) | Minimal top control bar, collapsible settings drawer, keyboard shortcuts, and fullscreen auto-hide. |
| **9. Performance & Debug** | [`src/perf/perfMonitor.ts`](src/perf/perfMonitor.ts), [`src/ui/debugView.ts`](src/ui/debugView.ts) | Zero-allocation FPS / frame-time / p95 ring buffer, telemetry overlay, 3D frustum & screen geometry diagram, and mirrored webcam landmark preview. |
| **10. Interactive 3D Windows Desktop** | [`src/desktop/desktopCapture.ts`](src/desktop/desktopCapture.ts), [`src/desktop/desktopSurface3D.ts`](src/desktop/desktopSurface3D.ts), [`src/desktop/desktopCoordinates.ts`](src/desktop/desktopCoordinates.ts), [`src/desktop/desktopInteraction.ts`](src/desktop/desktopInteraction.ts), [`electron/nativeDesktop.cjs`](electron/nativeDesktop.cjs), [`electron/preload.cjs`](electron/preload.cjs) | Live Windows 11 desktop capture via WGC/DXGI (`desktopCapturer`), `WDA_EXCLUDEFROMCAPTURE` infinite-mirror prevention, unlit back-wall 3D monitor surface, perspective raycasting, 3D virtual cursor, and native Win32 mouse/keyboard input forwarding. |

---

## 3. Projection & Eye-Tracking Mathematics

### 3.1 World Coordinate System

All physical coordinates are expressed in **metres** relative to the **centre of the monitor's visible image area**:

- **Origin** $(0, 0, 0)$: centre of the physical screen.
- **Horizontal axis ($+X$)**: right along the monitor width $W$.
- **Vertical axis ($+Y$)**: up along the monitor height $H$.
- **Normal / Depth axis ($+Z$)**: perpendicular to the monitor, pointing **out of the screen toward the viewer**.
- **Screen plane**: $z = 0$, spanning $[-W/2, +W/2] \times [-H/2, +H/2]$.
- **Virtual environment**: extends into $z < 0$ behind the physical monitor plane.
- **Viewer's eye position**: $\mathbf{e} = (x_e, y_e, z_e)$ with $z_e > 0$.

### 3.2 Generalized Off-Axis Perspective Projection

Following Kooima (*"Generalized Perspective Projection"*, 2008), let the physical screen rectangle be defined by three corners in world space:

$$\mathbf{p}_a = \left(-\frac{W}{2}, -\frac{H}{2}, 0\right), \quad \mathbf{p}_b = \left(+\frac{W}{2}, -\frac{H}{2}, 0\right), \quad \mathbf{p}_c = \left(-\frac{W}{2}, +\frac{H}{2}, 0\right)$$

The orthonormal screen basis $(\mathbf{v}_r, \mathbf{v}_u, \mathbf{v}_n)$ is:

$$\mathbf{v}_r = \frac{\mathbf{p}_b - \mathbf{p}_a}{\|\mathbf{p}_b - \mathbf{p}_a\|}, \quad \mathbf{v}_u = \frac{\mathbf{p}_c - \mathbf{p}_a}{\|\mathbf{p}_c - \mathbf{p}_a\|}, \quad \mathbf{v}_n = \frac{\mathbf{v}_r \times \mathbf{v}_u}{\|\mathbf{v}_r \times \mathbf{v}_u\|}$$

For an eye position $\mathbf{e}$, the vectors from the eye to the screen corners are $\mathbf{v}_a = \mathbf{p}_a - \mathbf{e}$, $\mathbf{v}_b = \mathbf{p}_b - \mathbf{e}$, $\mathbf{v}_c = \mathbf{p}_c - \mathbf{e}$, and the perpendicular eye-to-screen distance is:

$$d = -\mathbf{v}_a \cdot \mathbf{v}_n$$

By similar triangles, the asymmetric frustum extents $(l, r, b, t)$ on the near clipping plane $n$ are:

$$l = (\mathbf{v}_r \cdot \mathbf{v}_a)\frac{n}{d}, \quad r = (\mathbf{v}_r \cdot \mathbf{v}_b)\frac{n}{d}, \quad b = (\mathbf{v}_u \cdot \mathbf{v}_a)\frac{n}{d}, \quad t = (\mathbf{v}_u \cdot \mathbf{v}_c)\frac{n}{d}$$

For an axis-aligned monitor centred at the origin, this simplifies to:

$$l = \left(-\frac{W}{2} - x_e\right)\frac{n}{z_e}, \quad r = \left(\frac{W}{2} - x_e\right)\frac{n}{z_e}, \quad b = \left(-\frac{H}{2} - y_e\right)\frac{n}{z_e}, \quad t = \left(\frac{H}{2} - y_e\right)\frac{n}{z_e}$$

The projection matrix $\mathbf{P}$ is the standard OpenGL asymmetric frustum matrix $\operatorname{glFrustum}(l, r, b, t, n, f)$, and the view matrix $\mathbf{V}$ translates by $-\mathbf{e}$ and rotates into the screen basis $\mathbf{M}^T$:

$$\mathbf{V} = \mathbf{M}^T \mathbf{T}(-\mathbf{e}), \quad \mathbf{M} = \begin{bmatrix} \mathbf{v}_r & \mathbf{v}_u & \mathbf{v}_n & \mathbf{0} \\ 0 & 0 & 0 & 1 \end{bmatrix}$$

Notice that the camera orientation $\mathbf{M}^T$ depends **only on the screen plane**, never on the eye position. Rotating the camera toward the eye (`lookAt`) would tilt the projection plane away from the physical monitor and cause the room to detach and swing; keeping $\mathbf{M}^T$ locked to the screen plane while shifting the frustum bounds $(l, r, b, t)$ ensures any point $(x, y, 0)$ on the screen plane always projects to constant normalized device coordinates $(2x/W, 2y/H, 0)$ regardless of where the viewer moves.

### 3.3 Monocular Eye-Position Estimation & Reference Calibration

A monocular webcam does not measure metric depth directly. We recover 3D metric eye coordinates using a calibrated pinhole camera model and the human inter-pupillary distance ($\text{IPD}$, default $63\text{ mm}$):

1. **Eye midpoints**: From MediaPipe's 478 landmarks we compute the gaze-independent centre of each eye from its inner and outer canthi (landmarks `33, 133` for the right eye and `362, 263` for the left eye).
2. **Yaw & Off-Axis 3D Baseline Compensation**: We extract the 3D unit vector $\mathbf{d} = (d_x, d_y, d_z)$ of the inter-eye axis from the first column of MediaPipe's $4\times 4$ `facialTransformationMatrix` (`eyeAxisFromMatrix`). Using the exact pinhole baseline identity $z_c (\mathbf{r}_{L,xy} - \mathbf{r}_{R,xy}) = \text{IPD}(\mathbf{d}_{xy} - d_z \bar{\mathbf{r}}_{xy})$, the estimator removes both 2D yaw foreshortening and off-axis perspective foreshortening, recovering individual 3D world positions for the **cyclopean midpoint**, **left eye**, and **right eye**.
3. **Pinhole back-projection**: Given image width $w_{\text{px}}$ and horizontal field of view $\theta_h$, the focal length in pixels is $f_{\text{px}} = \frac{w_{\text{px}}/2}{\tan(\theta_h / 2)}$, giving camera-space coordinates:
   $$Z_c = \frac{f_{\text{px}} \cdot \text{IPD}}{\Delta_{\text{px}}}, \quad X_c = \frac{(u - c_x) Z_c}{f_{\text{px}}}, \quad Y_c = \frac{(v - c_y) Z_c}{f_{\text{px}}}$$
4. **Camera-to-world transform**: Accounting for the webcam's physical offset $\mathbf{c} = (c_x, c_y, c_z)$ from the screen centre, downward pitch angle $\alpha$, and the fact that the camera faces the viewer ($+Z$):
   $$\mathbf{e} = \mathbf{c} + \begin{bmatrix} -X_c \\ -Y_c \cos\alpha - Z_c \sin\alpha \\ -Y_c \sin\alpha + Z_c \cos\alpha \end{bmatrix}$$
5. **Single-Point & Two-Point Reference Calibration**:
   - **Single-point (`solveHfovFromReference`)**: Capturing a reference at a known distance $D_{\text{ref}}$ solves in closed form for $Z_c$, $f_{\text{px}}$, and $\theta_h$.
   - **Two-point (`solvePitchAndHfovFromTwoPoses`)**: Capturing a second reference at $D_{\text{ref}} + 20\text{ cm}$ at constant eye height solves $\sin\alpha = -(Y_{c,2} - Y_{c,1})/(D_2 - D_1)$ for the webcam's downward tilt angle $\alpha$ and calibrates $\theta_h$ simultaneously.

---

## 4. Calibration Guide

Click **Recalibrate** in the top bar (or press `C`) at any time to launch the 4-step calibration wizard:

1. **Step 1 — Monitor Size**: Select a screen diagonal preset (`14"`, `15.6"`, `24"`, `27"`, `32"`) or measure the visible image width and height with a ruler/tape in centimetres. Screen resolution is detected automatically.
2. **Step 2 — Webcam Mount**: Choose where your webcam sits (`Top Center`, `Top Left`, `Top Right`, `Bottom Bezel`, or `Custom`) and set the distance from the lens to the edge of the active display area ( plus any depth offset or downward tilt angle).
3. **Step 3 — Reference Capture**: Sit comfortably in front of the screen at a measured distance (e.g. `60 cm`), enter that distance, and click **Capture Reference Position (Webcam)**. The app averages 15 face-landmark frames and solves for your webcam's effective horizontal FOV so metric depth matches your real position.
4. **Step 4 — Verify & Save**: Inspect the **Depth Calibration** tunnel behind the wizard. Verify that the cyan `0 cm (SCREEN)` frame stays locked to the monitor bezel and that the concentric depth rings align when your eyes are centred. Click **Save Calibration** to persist settings in `localStorage`.

---

## 5. Controls & Keyboard Shortcuts

- **Mouse Simulation (when tracking is disabled or camera is stopped)**:
  - **Move mouse**: Horizontal ($X$) and vertical ($Y$) eye position
  - **Mouse wheel**: Viewing distance ($Z$, `15 cm` to `200 cm`)
  - **Double-click canvas** or **`R`**: Reset simulated eye to the central default distance
- **Keyboard Shortcuts**:
  - `F` — Toggle Fullscreen mode (HUD auto-hides after 2.6 s of mouse inactivity)
  - `H` — Reveal HUD controls while in Fullscreen
  - `S` — Open / close Settings drawer
  - `C` — Open Calibration Wizard
  - `T` — Toggle between Webcam Head Tracking and Mouse Simulation
  - `R` — Recenter Mouse Simulation eye position
  - `1` / `2` / `3` — Switch between **Virtual Room** (`1`), **Depth Calibration** (`2`), and **Floating Objects** (`3`)

---

## 6. Interactive Windows Desktop on the 3D Room Back Wall

When running in **Scene 1: Virtual Room**, the back wall of the 3D room embeds a live, fully interactive display of your actual **Windows 11 desktop**.

### 6.1 How Live Desktop Capture Works
- [`DesktopCaptureManager`](src/desktop/desktopCapture.ts) enumerates all connected Windows displays via Electron's `desktopCapturer` + `screen.getAllDisplays()` in [`electron/main.cjs`](electron/main.cjs) and streams the selected monitor at **60 FPS** (`native`, `1440p`, or `1080p`) into a hardware-decoded `<video>` element and `THREE.VideoTexture` (`SRGBColorSpace`, `LinearFilter`, `generateMipmaps = false`).
- [`DesktopSurface3D`](src/desktop/desktopSurface3D.ts) mounts the texture inside a 3D monitor bezel on the virtual room's back wall ($z = -d_{\text{desk}}$) using an unlit, fog-free `THREE.MeshBasicMaterial` (`toneMapped: false`) so desktop text, icons, and windows remain razor-sharp under off-axis projection while the surrounding 3D walls, floor, ceiling, bookshelves, and lighting remain visible around it.

### 6.2 How Recursive Capture ("Infinite Mirror") Is Prevented
- Before starting capture, the application enables **Windows Capture Exclusion** on its own window via Electron's `mainWindow.setContentProtection(true)` (`SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE = 0x11)`) combined with `WS_EX_LAYERED` in [`electron/nativeDesktop.cjs`](electron/nativeDesktop.cjs).
- Windows DWM omits the 3D Virtual Window from the captured desktop stream and composites the real underlying desktop and applications directly behind it—even when the 3D Virtual Window is maximized or fullscreen on a single monitor.

### 6.3 Perspective Raycasting & Coordinate Mapping
- Because the back-wall desktop is viewed through an asymmetric off-axis perspective frustum from the user's 3D eye position $\mathbf{e} = (x_e, y_e, z_e)$, screen space $(x_{\text{win}}, y_{\text{win}})$ does **not** map linearly by window size to the desktop.
- [`raycastDesktopSurface`](src/desktop/desktopCoordinates.ts) maps normalized device coordinates $(\text{ndc}_x, \text{ndc}_y) \in [-1, 1]^2$ to the 3D point $\mathbf{p}_s$ on the physical monitor plane ($z = 0$) and intersects the ray $\mathbf{r}(t) = \mathbf{e} + t(\mathbf{p}_s - \mathbf{e})$ with the 3D desktop plane $z = -d_{\text{desk}}$:
  $$t = \frac{-d_{\text{desk}} - z_e}{p_{s,z} - z_e}, \quad \mathbf{p}_w = \mathbf{e} + t(\mathbf{p}_s - \mathbf{e})$$
- The local surface coordinates $(u, v) \in [0, 1]^2$ are converted into physical Windows virtual-screen pixels $(X_{\text{desk}}, Y_{\text{desk}})$ accounting for display resolution, multi-monitor offset $(x_0, y_0)$, and DPI scale factor.

### 6.4 3D Virtual Cursor & Native Input Forwarding
- **3D Virtual Cursor**: When hovering over the back-wall desktop in Mode A, the native OS cursor is hidden (`cursor: none`) and a high-contrast 3D cursor (`arrow`, `ibeam`, `hand`, `resize`) is rendered directly on the 3D desktop surface at $\mathbf{p}_w$.
- **Native Win32 Input Injection**: Clicking, double-clicking, right-clicking, dragging windows/scrollbars/text, scrolling the mouse wheel, or typing on the keyboard forwards events through [`DesktopInteractionController`](src/desktop/desktopInteraction.ts) to [`electron/nativeDesktop.cjs`](electron/nativeDesktop.cjs), which briefly applies `WS_EX_TRANSPARENT` (click-through hit-testing) to the 3D window, positions the OS cursor at $(X_{\text{desk}}, Y_{\text{desk}})$, injects hardware mouse/keyboard events (`mouse_event` / `keybd_event`), activates the target Windows application (`WindowFromPoint` $\to$ `SetForegroundWindow`), and restores the cursor seamlessly.

### 6.5 Switching Between Desktop Interaction & 3D App Controls
- **Mode A — Desktop Interaction (`desktop`)**: Mouse and keyboard operate the Windows 11 desktop on the back wall. Hold `Alt` + move the mouse at any time to simulate 3D head movement when not using a webcam.
- **Mode B — 3D Application Controls (`app`)**: Mouse and keyboard control the 3D Virtual Window UI, settings drawer, and mouse eye simulator.
- **How to switch modes**:
  - Press **`Alt+Shift+D`** (configurable in Settings) or **`F8`** at any time—even when an external Windows app has focus.
  - Click the **🖥 Desktop Input: ON / 🎮 3D App Input** button in the top bar or the floating **Mode Indicator Pill** in the bottom-right corner.

---

## 7. Manual Physical Validation Protocol

Because the depth illusion depends on a human observer viewing a physical monitor, perform the following checks to physically validate the setup:

1. Complete the **Recalibrate** wizard with your monitor's true width and height (cm), then press `F` to enter **Fullscreen**.
2. Switch to **Scene 2: Depth Calibration** (`2`):
   - **Screen anchoring**: Move your head left, right, up, and down by ~20 cm. The outer cyan border (`0 cm (SCREEN)`) must stay glued to the four physical edges of your monitor without sliding or rotating.
   - **Sightline alignment**: Position your eyes directly in front of the screen centre (`X = 0, Y = 0` in the telemetry overlay). All 6 coloured rings (`-10 cm` to `-100 cm`) should appear concentric around the central crosshair.
   - **Lateral parallax**: Move your head to the **left**; you should see more of the **right** tunnel wall, and distant rings (`-100 cm`) should shift further left on the screen than near rings (`-10 cm`). Move **right**, **up**, and **down** to confirm the opposite walls/floor/ceiling are revealed accordingly.
   - **Viewing distance**: Lean closer (`~35 cm`) and farther (`~90 cm`). Moving closer widens the field of view through the window (making the `-100 cm` back rectangle appear smaller relative to the front opening).
3. Switch to **Scene 1: Virtual Room** (`1`) and **Scene 3: Floating Objects** (`3`) with one eye closed (monocular viewing removes conflicting binocular disparity cues on a 2D panel) to observe full head-coupled 3D depth.

---

## 7. Known Limitations

1. **Monocular Depth vs. Binocular Disparity**: Because a standard monitor emits a single flat image with zero binocular disparity and fixed accommodation distance, the illusion is strongest when viewed with one eye or at normal desktop distances (`50–80 cm`).
2. **Extreme Head Yaw & Off-Axis Perspective**: The `cos(yaw)` foreshortening correction from MediaPipe's facial transformation matrix compensates first-order head rotation, but when the head is simultaneously far off the camera's optical axis and rotated >30°, perspective foreshortening of the inter-eye baseline introduces a ~1.5–3% depth residual.
3. **Windowed Browser Chrome Offset**: In fullscreen mode, the canvas coincides with the monitor's display area. In windowed mode, the virtual opening is scaled to the canvas viewport so the room never clips.
4. **Lighting & Occlusion**: MediaPipe Face Landmarker requires clear visibility of both eyes; heavy backlighting or covering an eye triggers the hold-then-return fallback until tracking recovers.
