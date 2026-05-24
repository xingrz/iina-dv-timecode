import { DvTimestamp } from '../dv';

export interface Source {
  /**
   * Best-effort recording timestamp at the given playback position.
   *
   * For DV containers (raw/avi/mov) the position is converted to a frame
   * index using the source's internal fps and the frame's VAUX rec-date /
   * rec-time packs are decoded. For HDV (m2t) the source estimates a file
   * offset from `durationSec`, walks nearby TS packets to find a GOP
   * user_data section, and decodes its embedded packs.
   *
   * @param positionSec Current playback position in seconds.
   * @param durationSec Total stream duration in seconds; only used by HDV.
   * @returns The recording timestamp, or null if it could not be extracted.
   */
  timestampAt(positionSec: number, durationSec?: number): DvTimestamp | null;
  close(): void;
}
