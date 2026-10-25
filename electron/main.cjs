const { app, BrowserWindow, protocol, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const isSmoke = process.argv.includes('--smoke');
const devUrl = process.env.VITE_DEV_SERVER_URL;

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
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
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

      // 2. Measure steady-state render FPS over 600 ms
      await sleep(600);
      const fps = Number(api.perf.snapshot.fps.toFixed(1));
      const frameMs = Number(api.perf.snapshot.frameMs.toFixed(2));
      const p95FrameMs = Number(api.perf.snapshot.p95FrameMs.toFixed(2));

      // 3. Test real MediaPipe Face Landmarker worker + WASM on tests/fixtures/face.jpg
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
        ok: glError === 0 && !!det.face,
        glError,
        fps,
        frameMs,
        p95FrameMs,
        delegate: api.tracker.stats.delegate,
        coldDetectMs,
        warmDetectMs,
        poseProjections,
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

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'fullscreen');
  });

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
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const targetUrl = devUrl || (isSmoke ? 'app://bundle/index.html?smoke=1' : 'app://bundle/index.html');
  await win.loadURL(targetUrl);

  if (!isSmoke) {
    win.show();
    win.focus();
  }

  if (isSmoke) {
    try {
      await runSmokeVerification(win);
      app.exit(0);
    } catch (err) {
      console.error('[SMOKE_ERROR]', err);
      app.exit(1);
    }
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
