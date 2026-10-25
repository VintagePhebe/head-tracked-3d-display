import type { SceneId } from '../config/config';
import { CalibrationScene } from './calibrationScene';
import { FloatingObjectsScene } from './floatingScene';
import type { VirtualScene } from './sceneTypes';
import { VirtualRoomScene } from './virtualRoom';

export class SceneManager {
  private scenes: {
    room: VirtualRoomScene;
    calibration: CalibrationScene;
    floating: FloatingObjectsScene;
  };
  private activeId: SceneId;

  constructor(widthM: number, heightM: number, initial: SceneId = 'room') {
    this.scenes = {
      room: new VirtualRoomScene(widthM, heightM),
      calibration: new CalibrationScene(widthM, heightM),
      floating: new FloatingObjectsScene(widthM, heightM),
    };
    this.activeId = initial;
  }

  get room(): VirtualRoomScene {
    return this.scenes.room;
  }

  get active(): VirtualScene {
    return this.scenes[this.activeId];
  }

  get currentId(): SceneId {
    return this.activeId;
  }

  select(id: SceneId): VirtualScene {
    this.activeId = id;
    return this.scenes[id];
  }

  setScreenSize(widthM: number, heightM: number): void {
    for (const s of Object.values(this.scenes)) {
      s.setScreenSize(widthM, heightM);
    }
  }

  setScreenFrameVisible(visible: boolean): void {
    this.scenes.room.setScreenFrameVisible(visible);
    this.scenes.floating.setScreenFrameVisible(visible);
    // Calibration scene always shows its screen frame unless explicitly toggled.
    this.scenes.calibration.setScreenFrameVisible(true);
  }
}
