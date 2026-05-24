import { openRaw } from './raw';
import { openAvi } from './avi';
import { openMov } from './mov';
import { DvSource } from './types';

export type { DvSource } from './types';

/**
 * Open a file as a DV stream source. The handle is consumed: on success the
 * returned source owns it; on failure (unsupported container, not DV inside)
 * the handle is closed and null is returned.
 */
export function openDvSource(
  handle: IINA.API.FileHandle,
  ext: string,
): DvSource | null {
  switch (ext) {
    case 'dv':
      return openRaw(handle);
    case 'avi':
      return openAvi(handle);
    case 'mov':
    case 'qt':
      return openMov(handle);
    default:
      try { handle.close(); } catch { /* ignore */ }
      return null;
  }
}

export function isSupportedExt(ext: string): boolean {
  return ext === 'dv' || ext === 'avi' || ext === 'mov' || ext === 'qt';
}
