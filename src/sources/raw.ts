import { detectFormat, extractTimestamp } from '../dv';
import { fileSize } from '../io';
import { Source } from './types';

/** Raw DIF stream: the whole file is back-to-back frames of fixed size. */
export function openRaw(handle: IINA.API.FileHandle): Source | null {
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
    timestampAt(positionSec) {
      const frameIdx = Math.max(0, Math.floor(positionSec * format.fps));
      if (frameIdx >= frameCount) return null;
      handle.seekTo(frameIdx * format.frameSize);
      const buf = handle.read(format.frameSize);
      return buf && buf.length > 0 ? extractTimestamp(buf) : null;
    },
    close() {
      try { handle.close(); } catch { /* ignore */ }
    },
  };
}
