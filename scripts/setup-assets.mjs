// Copies the MediaPipe WASM runtime into public/ and downloads the face model if missing,
// so the app works fully offline (no CDN at runtime).
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = join(root, 'public', 'mediapipe', 'wasm');
const modelDst = join(root, 'public', 'models', 'face_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

mkdirSync(wasmDst, { recursive: true });
// Only the ES-module runtime is needed: detection runs inside a module Web Worker.
for (const f of ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm']) {
  copyFileSync(join(wasmSrc, f), join(wasmDst, f));
}
console.log('[assets] MediaPipe WASM copied');

if (!existsSync(modelDst)) {
  mkdirSync(dirname(modelDst), { recursive: true });
  console.log('[assets] downloading face_landmarker.task ...');
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  writeFileSync(modelDst, Buffer.from(await res.arrayBuffer()));
}
console.log('[assets] face model present');
