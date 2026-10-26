/**
 * Real-time UVC MJPEG Frame Sanitizer (De-Glitcher).
 *
 * Built-in laptop UVC webcams that stream MJPEG over USB 2.0 (such as SunplusIT / Realtek VID_30C9
 * with Windows Frame Server MJPGTranslationSubType=NV12) can drop isochronous packets mid-frame.
 * Each dropped packet corrupts a single 8-pixel-tall JPEG MCU row: a few 8x8 macroblocks decode
 * with garbled chroma (pink/green) and the remainder of that MCU row is aborted to the right edge
 * of the raw frame and filled with a constant value (grey 128, black 0/16, or NV12 zero-green).
 *
 * This sanitizer combines:
 *  - Spatial detection (constant-color MJPEG abort tails and flat macroblock runs)
 *  - Temporal band outlier detection (isolated 8px/16px horizontal strips that jump relative to
 *    the rolling clean frame while rows immediately above and below remain static)
 * and reconstructs corrupted MCU rows from the rolling clean-row buffer (or vertical interpolation
 * on the first frame).
 */

export class WebcamFrameSanitizer {
  private width = 0;
  private height = 0;
  private cleanData: Uint8ClampedArray | null = null;
  private hasCleanRow: Uint8Array | null = null;
  private corruptMask: Uint8Array | null = null;
  private rowTemporalDiff: Float32Array | null = null;

  /**
   * Inspects `imgData` in-place, heals any MJPEG-corrupted MCU rows, and updates the rolling
   * clean-row buffer. Returns the number of healed rows.
   */
  sanitize(imgData: ImageData): number {
    const W = imgData.width;
    const H = imgData.height;
    const data = imgData.data;
    if (W <= 0 || H <= 0) return 0;

    if (
      this.width !== W ||
      this.height !== H ||
      !this.cleanData ||
      !this.hasCleanRow ||
      !this.corruptMask ||
      !this.rowTemporalDiff
    ) {
      this.width = W;
      this.height = H;
      this.cleanData = new Uint8ClampedArray(W * H * 4);
      this.hasCleanRow = new Uint8Array(H);
      this.corruptMask = new Uint8Array(H);
      this.rowTemporalDiff = new Float32Array(H);
    }

    const clean = this.cleanData;
    const hasClean = this.hasCleanRow;
    const mask = this.corruptMask;
    const tDiff = this.rowTemporalDiff;
    mask.fill(0);

    // 1. Spatial check: detect rows containing an MJPEG abort tail or flat macroblock run
    for (let y = 0; y < H; y++) {
      if (this.isRowSpatiallyCorrupted(data, W, y)) {
        const y0 = Math.max(0, (y & ~7) - 2);
        const y1 = Math.min(H - 1, (y | 7) + 2);
        for (let ky = y0; ky <= y1; ky++) {
          mask[ky] = 1;
        }
      }
    }

    // 2. Temporal band outlier check: detect isolated 8px/16px horizontal strips that jump
    //    sharply relative to clean history while rows just above and below remain steady.
    for (let y = 0; y < H; y++) {
      if (hasClean[y] === 0) {
        tDiff[y] = 0;
        continue;
      }
      const rowStart = y * W * 4;
      let sum = 0;
      let samples = 0;
      for (let x = 0; x < W; x += 8) {
        const idx = rowStart + x * 4;
        sum +=
          Math.abs(data[idx] - clean[idx]) +
          Math.abs(data[idx + 1] - clean[idx + 1]) +
          Math.abs(data[idx + 2] - clean[idx + 2]);
        samples++;
      }
      tDiff[y] = samples > 0 ? sum / samples : 0;
    }

    for (let mcuY = 0; mcuY < H; mcuY += 8) {
      const mcuEnd = Math.min(H - 1, mcuY + 7);
      let bandDiff = 0;
      for (let y = mcuY; y <= mcuEnd; y++) {
        if (tDiff[y] > bandDiff) bandDiff = tDiff[y];
      }
      if (bandDiff < 52) continue;

      const topRefY = Math.max(0, mcuY - 10);
      const botRefY = Math.min(H - 1, mcuEnd + 10);
      const neighborDiff = Math.min(tDiff[topRefY], tDiff[botRefY]);
      if (neighborDiff < 20 && bandDiff > neighborDiff * 3.2) {
        const y0 = Math.max(0, mcuY - 2);
        const y1 = Math.min(H - 1, mcuEnd + 2);
        for (let ky = y0; ky <= y1; ky++) {
          mask[ky] = 1;
        }
      }
    }

    // Bridge tiny 1..4px gaps between adjacent corrupted MCU bands
    for (let y = 1; y < H - 4; y++) {
      if (
        mask[y - 1] === 1 &&
        mask[y] === 0 &&
        (mask[y + 1] === 1 || mask[y + 2] === 1 || mask[y + 3] === 1 || mask[y + 4] === 1)
      ) {
        mask[y] = 1;
      }
    }

    const rowBytes = W * 4;
    let healedRows = 0;

    // 3. Update clean history for all uncorrupted rows first
    for (let y = 0; y < H; y++) {
      if (mask[y] === 0) {
        const off = y * rowBytes;
        clean.set(data.subarray(off, off + rowBytes), off);
        hasClean[y] = 1;
      }
    }

    // 4. Reconstruct corrupted rows from temporal clean history (or vertical interpolation on cold start)
    for (let y = 0; y < H; y++) {
      if (mask[y] === 0) continue;
      healedRows++;
      const off = y * rowBytes;
      if (hasClean[y] === 1) {
        data.set(clean.subarray(off, off + rowBytes), off);
      } else {
        let yTop = y - 1;
        while (yTop >= 0 && mask[yTop] === 1) yTop--;
        let yBot = y + 1;
        while (yBot < H && mask[yBot] === 1) yBot++;

        if (yTop >= 0 && yBot < H) {
          const t = (y - yTop) / (yBot - yTop);
          const invT = 1 - t;
          const topOff = yTop * rowBytes;
          const botOff = yBot * rowBytes;
          for (let i = 0; i < rowBytes; i++) {
            data[off + i] = Math.round(data[topOff + i] * invT + data[botOff + i] * t);
          }
        } else if (yTop >= 0) {
          const topOff = yTop * rowBytes;
          data.set(data.subarray(topOff, topOff + rowBytes), off);
        } else if (yBot < H) {
          const botOff = yBot * rowBytes;
          data.set(data.subarray(botOff, botOff + rowBytes), off);
        }
      }
    }

    return healedRows;
  }

  private isRowSpatiallyCorrupted(data: Uint8ClampedArray, W: number, y: number): boolean {
    const rowStart = y * W * 4;

    // Check A: Rightmost 14 pixels of raw unmirrored row (where MJPEG row abort terminates)
    if (W >= 32) {
      const tailLen = 14;
      const startX = W - tailLen;
      const i0 = rowStart + startX * 4;
      const r0 = data[i0];
      const g0 = data[i0 + 1];
      const b0 = data[i0 + 2];

      // Exclude natural overexposed white ceiling highlights (R,G,B > 245)
      const isBlownWhite = r0 > 245 && g0 > 245 && b0 > 245;
      if (!isBlownWhite) {
        const isNeutralAbort =
          Math.abs(r0 - g0) <= 7 &&
          Math.abs(g0 - b0) <= 7 &&
          Math.abs(r0 - b0) <= 7 &&
          (r0 <= 24 || (r0 >= 106 && r0 <= 150));

        let flatPairs = 0;
        let prevR = r0;
        let prevG = g0;
        let prevB = b0;
        for (let x = startX + 1; x < W; x++) {
          const idx = rowStart + x * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          if (Math.abs(r - prevR) <= 1 && Math.abs(g - prevG) <= 1 && Math.abs(b - prevB) <= 1) {
            flatPairs++;
          }
          prevR = r;
          prevG = g;
          prevB = b;
        }
        if ((isNeutralAbort && flatPairs >= tailLen - 3) || flatPairs >= tailLen - 1) {
          return true;
        }
      }
    }

    // Check B: Contiguous horizontal run of >= 20 identical digital grey/black pixels anywhere in the row
    let run = 0;
    let prevR = -999;
    let prevG = -999;
    let prevB = -999;

    for (let x = 0; x < W; x += 2) {
      const idx = rowStart + x * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      const isGreyOrBlack =
        Math.abs(r - g) <= 6 &&
        Math.abs(g - b) <= 6 &&
        Math.abs(r - b) <= 6 &&
        (r <= 20 || (r >= 110 && r <= 146));

      if (
        isGreyOrBlack &&
        Math.abs(r - prevR) <= 1 &&
        Math.abs(g - prevG) <= 1 &&
        Math.abs(b - prevB) <= 1
      ) {
        run++;
        if (run >= 10) return true;
      } else {
        run = isGreyOrBlack ? 1 : 0;
        prevR = r;
        prevG = g;
        prevB = b;
      }
    }

    return false;
  }
}
