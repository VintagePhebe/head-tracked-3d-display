/** Webcam capture via getUserMedia, with user-facing error classification. */

export type CameraErrorKind = 'unsupported' | 'permission-denied' | 'no-camera' | 'camera-busy' | 'disconnected' | 'unknown';

export class CameraError extends Error {
  constructor(public kind: CameraErrorKind, message: string) {
    super(message);
    this.name = 'CameraError';
  }
}

/** Map getUserMedia DOMExceptions to actionable messages. */
export function classifyCameraError(err: unknown): CameraError {
  if (err instanceof CameraError) return err;
  const name = (err as { name?: string })?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new CameraError('permission-denied', 'Camera permission was denied. Allow camera access for this app in the browser / Windows privacy settings (Settings → Privacy & security → Camera), then try again.');
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new CameraError('no-camera', 'No webcam was found (or the selected webcam is unavailable). Connect a webcam or pick another device in Settings. Mouse simulation remains available.');
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError('camera-busy', 'The webcam could not be started — it may be in use by another application (Teams, Zoom, Camera app…). Close it and try again.');
    default:
      return new CameraError('unknown', `Camera error: ${(err as Error)?.message ?? String(err)}`);
  }
}

export interface CameraDevice {
  deviceId: string;
  label: string;
}

type MediaDevicesLike = Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'>;

export async function listCameras(md: MediaDevicesLike | undefined = navigator.mediaDevices): Promise<CameraDevice[]> {
  if (!md?.enumerateDevices) return [];
  const all = await md.enumerateDevices();
  return all
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

/** Open a webcam stream. Prefers 1280x720@60 (wide FOV, no 4:3 crop), accepts anything. */
export async function openCamera(deviceId: string, md: MediaDevicesLike | undefined = globalThis.navigator?.mediaDevices): Promise<MediaStream> {
  if (!md?.getUserMedia) {
    throw new CameraError('unsupported', 'Camera access is not available here (requires a secure context: https, localhost or the desktop app).');
  }
  const video: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 60 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
  };
  try {
    return await md.getUserMedia({ video, audio: false });
  } catch (err) {
    const e = classifyCameraError(err);
    if (deviceId && e.kind === 'no-camera') {
      // Stored device vanished: fall back to any camera.
      try {
        return await md.getUserMedia({ video: { ...video, deviceId: undefined }, audio: false });
      } catch (err2) {
        throw classifyCameraError(err2);
      }
    }
    throw e;
  }
}
