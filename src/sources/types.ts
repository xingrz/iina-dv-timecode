import { DvFormat } from '../dv';

export interface DvSource {
  readonly format: DvFormat;
  readonly frameCount: number;
  /**
   * Read the full bytes of the given DV frame (typically `format.frameSize`,
   * less if EOF). Returns null if the frame is out of range or the read came
   * up short. Callers scan the result for VAUX packs.
   */
  readFrame(frameIdx: number): Uint8Array | null;
  close(): void;
}
