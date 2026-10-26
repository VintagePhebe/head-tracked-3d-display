const {
  app,
  BrowserWindow,
  protocol,
  session,
  ipcMain,
  desktopCapturer,
  screen,
  globalShortcut,
  clipboard,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { NativeDesktopHelper, getWindowHwndNumber } = require('./nativeDesktop.cjs');

const isSmoke = process.argv.includes('--smoke');
const devUrl = process.env.VITE_DEV_SERVER_URL;
const nativeDesktop = new NativeDesktopHelper();
let mainWindow = null;
let currentShortcut = null;
let wantCaptureExclusion = true;
let autoScreenshotHold = false;
let manualAllowCapture = false;
let resumeTimer = null;

async function applyWindowExclusion(exclude) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  const flag = Boolean(exclude);
  try {
    mainWindow.setContentProtection(flag);
  } catch {
    // Ignore if unsupported on platform
  }
  const hwnd = getWindowHwndNumber(mainWindow);
  nativeDesktop.setCaptureExclusion(hwnd, flag).catch(() => {});
  return { ok: true };
}

function syncEffectiveScreenshotHold() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const shouldHold = manualAllowCapture || autoScreenshotHold;
  if (resumeTimer) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  if (shouldHold) {
    // 1. Freeze 3D back-wall desktop texture on its clean frame first
    mainWindow.webContents.send('desktop:screenshot-hold', true);
    // 2. Disable WDA_EXCLUDEFROMCAPTURE 8ms later so Win+Shift+S / Snipping Tool sees the window
    setTimeout(() => {
      if (manualAllowCapture || autoScreenshotHold) {
        applyWindowExclusion(false);
      }
    }, 8);
  } else if (wantCaptureExclusion) {
    // 1. Re-enable WDA_EXCLUDEFROMCAPTURE first
    applyWindowExclusion(true);
    // 2. Wait 160ms for DWM capture pipeline to flush before unfreezing 3D back-wall video
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      if (!manualAllowCapture && !autoScreenshotHold && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop:screenshot-hold', false);
      }
    }, 160);
  } else {
    mainWindow.webContents.send('desktop:screenshot-hold', false);
  }
}

async function captureWindowScreenshot() {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  try {
    const img = await mainWindow.webContents.capturePage();
    clipboard.writeImage(img);
    const picturesDir = app.getPath('pictures');
    const shotsDir = path.join(picturesDir, 'Screenshots');
    try {
      await fs.promises.mkdir(shotsDir, { recursive: true });
    } catch {
      // Ignore
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filePath = path.join(shotsDir, `VirtualWindow-${stamp}.png`);
    await fs.promises.writeFile(filePath, img.toPNG());
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:screenshot-saved', { filePath });
    }
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Avoid Windows 11 hybrid-GPU D3D11 NV12 webcam stride/chroma corruption (cyan tint, scanline tears, bottom grey padding bar)
// (testing default MediaFoundation vs flags)

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function registerAppProtocol() {
  const distRoot = path.join(__dirname, '..', 'dist');
  const repoRoot = path.join(__dirname, '..');

  protocol.handle('app', async (request) => {
    const u = new URL(request.url);
    const relPath = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const baseDir = relPath.startsWith('tests/') ? repoRoot : distRoot;
    const filePath = path.normalize(path.join(baseDir, relPath));
    if (!filePath.startsWith(baseDir) || !fs.existsSync(filePath)) {
      return new Response('Not found', { status: 404 });
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const data = await fs.promises.readFile(filePath);
    return new Response(data, {
      status: 200,
      headers: { 'content-type': mime },
    });
  });
}

async function runSmokeVerification(win) {
  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await sleep(300);
      const api = window.__virtualWindow;
      if (!api) throw new Error('__virtualWindow API not initialized');

      const gl = api.renderer.renderer.getContext();
      const glError = gl.getError();

      // 1. Test all 3 scenes render and off-axis projection updates across eye positions
      const poses = {
        center: [0, 0, 0.6],
        left: [-0.15, 0, 0.6],
        right: [0.15, 0, 0.6],
        up: [0, 0.10, 0.6],
        closer: [0, 0, 0.38],
      };
      const poseProjections = {};
      for (const [name, [x, y, z]] of Object.entries(poses)) {
        api.mouseSim.setEye(x, y, z, true);
        await sleep(45);
        const p = api.getLastProjection();
        poseProjections[name] = {
          distance: Number(p.distance.toFixed(4)),
          left: Number(p.left.toFixed(5)),
          right: Number(p.right.toFixed(5)),
          bottom: Number(p.bottom.toFixed(5)),
          top: Number(p.top.toFixed(5)),
        };
      }

      // Reset to a slight off-axis vantage and cycle all 3 scenes
      api.mouseSim.setEye(-0.10, 0.06, 0.55, true);
      for (const sceneId of ['room', 'calibration', 'floating']) {
        const next = structuredClone(api.getConfig());
        next.render.scene = sceneId;
        api.applyConfig(next, false);
        api.mouseSim.setEye(-0.10, 0.06, 0.55, true);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }

      // Return to room scene so the 3D back-wall desktop is active
      const roomCfg = structuredClone(api.getConfig());
      roomCfg.render.scene = 'room';
      api.applyConfig(roomCfg, false);

      // 2. Measure steady-state render FPS over 600 ms
      await sleep(600);
      const fps = Number(api.perf.snapshot.fps.toFixed(1));
      const frameMs = Number(api.perf.snapshot.frameMs.toFixed(2));
      const p95FrameMs = Number(api.perf.snapshot.p95FrameMs.toFixed(2));

      // 3. Verify 3D Windows Desktop integration, capture exclusion & perspective raycasting
      const dStats = api.desktopCapture.stats;
      const dSpec = api.scenes.room.desktopSurface.getSpec();
      const screenRect = {
        pa: { x: -roomCfg.screen.widthCm / 200, y: -roomCfg.screen.heightCm / 200, z: 0 },
        pb: { x: roomCfg.screen.widthCm / 200, y: -roomCfg.screen.heightCm / 200, z: 0 },
        pc: { x: -roomCfg.screen.widthCm / 200, y: roomCfg.screen.heightCm / 200, z: 0 },
      };
      const hitCenter = api.raycastDesktopSurface({ x: 0, y: 0, z: 0.6 }, screenRect, 0, 0, dSpec);
      const hitHeadLeft = api.raycastDesktopSurface({ x: -0.14, y: 0, z: 0.6 }, screenRect, 0, 0, dSpec);
      const hitHeadRight = api.raycastDesktopSurface({ x: 0.14, y: 0, z: 0.6 }, screenRect, 0, 0, dSpec);

      const modeBefore = api.getConfig().desktop.interactionMode;
      const modeToggled = api.desktopInteraction.toggleMode();
      const modeRestored = api.desktopInteraction.toggleMode();

      // 4. Test real MediaPipe Face Landmarker worker + WASM on tests/fixtures/face.jpg
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Failed to load fixture face.jpg'));
        img.src = 'app://bundle/tests/fixtures/face.jpg';
      });
      // First call includes one-time WebGL shader compilation; second call measures steady-state inference.
      await api.tracker.detectStill(img);
      const coldDetectMs = Number(api.tracker.stats.detectMs.toFixed(2));
      const det = await api.tracker.detectStill(img);
      const warmDetectMs = Number(api.tracker.stats.detectMs.toFixed(2));
      if (!det.face) throw new Error('MediaPipe FaceLandmarker did not detect face in fixture');
      const eyeEst = api.estimateEyeFromFace(det.face, det.width, det.height);

      return {
        ok: glError === 0 && !!det.face && api.scenes.room.desktopSurface.group.visible,
        glError,
        fps,
        frameMs,
        p95FrameMs,
        delegate: api.tracker.stats.delegate,
        coldDetectMs,
        warmDetectMs,
        poseProjections,
        desktopIntegration: {
          surfaceVisible: api.scenes.room.desktopSurface.group.visible,
          captureActive: dStats.active,
          excludeFromCapture: dStats.excludeFromCapture,
          resolution: [dStats.width, dStats.height],
          surfaceMeters: [Number(dSpec.widthM.toFixed(3)), Number(dSpec.heightM.toFixed(3)), Number(dSpec.depthM.toFixed(3))],
          raycastParallax: {
            centerPx: [hitCenter.desktopX, hitCenter.desktopY],
            headLeftPx: [hitHeadLeft.desktopX, hitHeadLeft.desktopY],
            headRightPx: [hitHeadRight.desktopX, hitHeadRight.desktopY],
          },
          modeToggle: [modeBefore, modeToggled, modeRestored],
        },
        faceDetection: {
          imageSize: [det.width, det.height],
          rightEye: det.face.rightEye,
          leftEye: det.face.leftEye,
          foreshortening: Number(det.face.foreshortening.toFixed(4)),
          ipdPx: Number(eyeEst.ipdPx.toFixed(2)),
          estimatedEyeCm: {
            x: Number((eyeEst.eye.x * 100).toFixed(2)),
            y: Number((eyeEst.eye.y * 100).toFixed(2)),
            z: Number((eyeEst.eye.z * 100).toFixed(2)),
          },
        },
      };
    })()
  `);
  console.log('[SMOKE_RESULT]', JSON.stringify(result, null, 2));
}

function registerDesktopIpcHandlers() {
  ipcMain.handle('desktop:get-sources', async () => {
    try {
      const displays = screen.getAllDisplays();
      const primary = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });

      return sources.map((src, idx) => {
        const matched =
          displays.find((d) => String(d.id) === String(src.display_id)) ||
          displays[idx] ||
          primary;
        const scale = matched?.scaleFactor || 1;
        const b = matched?.bounds || { x: 0, y: 0, width: 1920, height: 1080 };
        const isPrimary = matched ? matched.id === primary.id : idx === 0;
        return {
          id: src.id,
          displayId: String(matched?.id ?? idx),
          name: isPrimary ? `Primary Display (${src.name || idx + 1})` : src.name || `Display ${idx + 1}`,
          isPrimary,
          bounds: {
            x: Math.round(b.x * scale),
            y: Math.round(b.y * scale),
            width: Math.round(b.width * scale),
            height: Math.round(b.height * scale),
            dipX: b.x,
            dipY: b.y,
            dipWidth: b.width,
            dipHeight: b.height,
            scaleFactor: scale,
          },
        };
      });
    } catch (err) {
      return [];
    }
  });

  ipcMain.handle('desktop:set-capture-exclusion', async (_evt, enabled) => {
    wantCaptureExclusion = Boolean(enabled);
    if (manualAllowCapture || autoScreenshotHold) {
      return applyWindowExclusion(false);
    }
    return applyWindowExclusion(wantCaptureExclusion);
  });

  ipcMain.handle('desktop:set-allow-screenshots', async (_evt, allow) => {
    manualAllowCapture = Boolean(allow);
    syncEffectiveScreenshotHold();
    return { ok: true, allowScreenshots: manualAllowCapture };
  });

  ipcMain.handle('desktop:take-screenshot', async () => {
    return captureWindowScreenshot();
  });

  ipcMain.handle('desktop:set-always-on-top', async (_evt, enabled) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    try {
      const flag = Boolean(enabled);
      mainWindow.setAlwaysOnTop(flag, flag ? 'screen-saver' : 'normal');
      const hwnd = getWindowHwndNumber(mainWindow);
      nativeDesktop.setDesktopModeWindowFlags(hwnd, flag).catch(() => {});
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('desktop:mouse-event', async (_evt, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    const hwnd = getWindowHwndNumber(mainWindow);
    return nativeDesktop.sendMouse(hwnd, payload || {});
  });

  ipcMain.handle('desktop:key-event', async (_evt, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    const hwnd = getWindowHwndNumber(mainWindow);
    return nativeDesktop.sendKey(hwnd, payload || {});
  });

  ipcMain.handle('desktop:get-cursor', async () => {
    return nativeDesktop.send({ type: 'cursor' });
  });

  ipcMain.handle('desktop:register-shortcut', async (_evt, accelerator) => {
    try {
      if (currentShortcut) {
        globalShortcut.unregister(currentShortcut);
        currentShortcut = null;
      }
      globalShortcut.unregister('F8');
      const triggerToggle = () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('desktop:toggle-mode');
        }
      };
      try {
        globalShortcut.register('F8', triggerToggle);
      } catch {
        // Ignore if F8 is already bound
      }
      if (!accelerator || typeof accelerator !== 'string') {
        return { ok: true };
      }
      const ok = globalShortcut.register(accelerator, triggerToggle);
      if (ok) currentShortcut = accelerator;
      return { ok };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(
      permission === 'media' ||
        permission === 'display-capture' ||
        permission === 'fullscreen',
    );
  });

  if (session.defaultSession.setDisplayMediaRequestHandler) {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (sources.length > 0) {
          callback({ video: sources[0] });
        } else {
          callback({});
        }
      } catch {
        callback({});
      }
    });
  }

  registerDesktopIpcHandlers();
  nativeDesktop.onEvent = (msg) => {
    if (isSmoke) return;
    if (msg.event === 'screenshot_hold') {
      autoScreenshotHold = Boolean(msg.active);
      syncEffectiveScreenshotHold();
    } else if (msg.event === 'print_screen') {
      captureWindowScreenshot();
    }
  };
  nativeDesktop.start();

  if (!devUrl) registerAppProtocol();

  const win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#05070c',
    autoHideMenuBar: true,
    show: true,
    opacity: isSmoke ? 0.01 : 1,
    skipTaskbar: isSmoke,
    focusable: !isSmoke,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWindow = win;

  win.webContents.on('before-input-event', (_event, input) => {
    if (isSmoke || input.type !== 'keyDown') return;
    if (input.meta && input.shift && input.code === 'KeyS') {
      autoScreenshotHold = true;
      syncEffectiveScreenshotHold();
    } else if (input.key === 'F12' && !input.control && !input.alt) {
      captureWindowScreenshot();
    }
  });

  const targetUrl = devUrl || (isSmoke ? 'app://bundle/index.html?smoke=1' : 'app://bundle/index.html');
  await win.loadURL(targetUrl);

  if (!isSmoke) {
    win.maximize();
    win.show();
    win.focus();
  }

  if (isSmoke) {
    try {
      await runSmokeVerification(win);
      nativeDesktop.dispose();
      app.exit(0);
    } catch (err) {
      console.error('[SMOKE_ERROR]', err);
      nativeDesktop.dispose();
      app.exit(1);
    }
  }
});

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch {
    // Ignore
  }
  nativeDesktop.dispose();
});

app.on('window-all-closed', () => {
  nativeDesktop.dispose();
  app.quit();
});
