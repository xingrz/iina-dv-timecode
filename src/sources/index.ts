import { openAvi } from './avi';
import { openM2t } from './m2t';
import { openMov } from './mov';
import { openRaw } from './raw';
import { Source } from './types';

export type { Source } from './types';

/**
 * Open a file as a recording-timestamp source. The handle is consumed: on
 * success the returned source owns it; on failure (unsupported container,
 * not DV/HDV inside) the handle is closed and null is returned.
 */
export function openSource(
  handle: IINA.API.FileHandle,
  ext: string,
): Source | null {
  switch (ext) {
    case 'dv':
      return openRaw(handle);
    case 'avi':
      return openAvi(handle);
    case 'mov':
    case 'qt':
      return openMov(handle);
    case 'm2t':
    case 'ts':
      return openM2t(handle);
    default:
      try { handle.close(); } catch { /* ignore */ }
      return null;
  }
}

export function isSupportedExt(ext: string): boolean {
  return (
    ext === 'dv' ||
    ext === 'avi' ||
    ext === 'mov' ||
    ext === 'qt' ||
    ext === 'm2t' ||
    ext === 'ts'
  );
}
