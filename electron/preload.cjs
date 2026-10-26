const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', {
  isElectron: true,

  /**
   * Enumerate available Windows displays and their corresponding desktopCapturer source IDs.
   */
  getSources: () => ipcRenderer.invoke('desktop:get-sources'),

  /**
   * Enable or disable Windows capture exclusion (WDA_EXCLUDEFROMCAPTURE) on the 3D window
   * so capturing the desktop never produces an infinite mirror.
   */
  setCaptureExclusion: (enabled) => ipcRenderer.invoke('desktop:set-capture-exclusion', Boolean(enabled)),

  /**
   * Keep the 3D window visible above normal desktop apps while interacting with them.
   */
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('desktop:set-always-on-top', Boolean(enabled)),

  /**
   * Inject a mouse action (down, up, click, dblclick, dragmove, wheel) at physical desktop
   * coordinates (x, y) while making the 3D window click-through for hit-testing.
   */
  sendMouse: (event) => ipcRenderer.invoke('desktop:mouse-event', event),

  /**
   * Inject a keyboard event (down, up) to the active desktop window.
   */
  sendKey: (event) => ipcRenderer.invoke('desktop:key-event', event),

  /**
   * Poll current Windows system cursor shape ('arrow' | 'ibeam' | 'hand' | 'wait' | 'resize').
   */
  getCursorShape: () => ipcRenderer.invoke('desktop:get-cursor'),

  /**
   * Register/update the global shortcut used to toggle between Mode A (Desktop Interaction)
   * and Mode B (3D Application Controls) even when another Windows application has focus.
   */
  registerModeShortcut: (accelerator) => ipcRenderer.invoke('desktop:register-shortcut', accelerator),

  /**
   * Subscribe to global mode-toggle shortcut events triggered from the main process.
   */
  onToggleModeShortcut: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('desktop:toggle-mode', listener);
    return () => ipcRenderer.removeListener('desktop:toggle-mode', listener);
  },

  /**
   * Capture a screenshot of the 3D window directly to the Windows Clipboard and Pictures/Screenshots.
   */
  takeScreenshot: () => ipcRenderer.invoke('desktop:take-screenshot'),

  /**
   * Manually allow or block OS screen capture (Win+Shift+S / OBS / Discord) while freezing
   * the 3D back-wall desktop frame to avoid infinite-mirror recursion.
   */
  setAllowScreenshots: (allow) => ipcRenderer.invoke('desktop:set-allow-screenshots', Boolean(allow)),

  /**
   * Subscribe to automatic or manual screenshot-hold transitions so the 3D back-wall
   * texture freezes its clean frame before WDA_EXCLUDEFROMCAPTURE is lifted.
   */
  onScreenshotHold: (callback) => {
    const listener = (_evt, hold) => callback(Boolean(hold));
    ipcRenderer.on('desktop:screenshot-hold', listener);
    return () => ipcRenderer.removeListener('desktop:screenshot-hold', listener);
  },

  /**
   * Subscribe to screenshot-saved notifications.
   */
  onScreenshotSaved: (callback) => {
    const listener = (_evt, info) => callback(info);
    ipcRenderer.on('desktop:screenshot-saved', listener);
    return () => ipcRenderer.removeListener('desktop:screenshot-saved', listener);
  },
});
