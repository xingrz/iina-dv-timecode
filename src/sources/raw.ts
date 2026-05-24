import { detectFormat } from '../dv';
import { fileSize } from '../io';
import { DvSource } from './types';

/** Raw DIF stream: the whole file is back-to-back frames of fixed size. */
export function openRaw(handle: IINA.API.FileHandle): DvSource | null {
  handle.seekTo(0);
  const header = handle.read(4);
  if (!header || header.length < 4) {
    handle.close();
    return null;
  }
  const format = detectFormat(header);
  if (!format) {
    handle.close();
    return null;
  }

  const frameCount = Math.floor(fileSize(handle) / format.frameSize);

  return {
    format,
    frameCount,
    readFrame(frameIdx) {
      if (frameIdx < 0 || frameIdx >= frameCount) return null;
      handle.seekTo(frameIdx * format.frameSize);
      const buf = handle.read(format.frameSize);
      return buf && buf.length > 0 ? buf : null;
    },
    close() {
      try { handle.close(); } catch { /* ignore */ }
    },
  };
}
