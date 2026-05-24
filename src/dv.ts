// Raw DV (DIF) bitstream parser, just enough to pull the recording timestamp.
// References: SMPTE 314M-1999 / IEC 61834-4.

export const DIF_BLOCK_SIZE = 80;
export const DIF_SEQUENCE_SIZE = 12000; // 150 blocks per sequence
export const FRAME_SIZE_NTSC = 120000;  // 10 sequences per frame
export const FRAME_SIZE_PAL = 144000;   // 12 sequences per frame
export const FPS_NTSC = 30000 / 1001;
export const FPS_PAL = 25;

export type DvSystem = 'ntsc' | 'pal';

export interface DvFormat {
  system: DvSystem;
  frameSize: number;
  fps: number;
}

export interface DvTimestamp {
  year: number;
  month: number;
  day: number;
  // Optional because some sources (notably HDV) only expose a reliable
  // recording date — the 0x63 pack they carry is SMPTE timecode rather than
  // wall-clock, and showing it as time would be misleading.
  hour?: number;
  minute?: number;
  second?: number;
}

// VAUX pack headers we care about. The audio side (0x52/0x53) carries the same
// info and could be used as a fallback, but consumer DV reliably populates VAUX.
const PACK_VAUX_REC_DATE = 0x62;
const PACK_VAUX_REC_TIME = 0x63;

/**
 * Detect the DV system (NTSC vs PAL) from the first DIF block (the Header
 * section). Returns null if the bytes don't look like a DV header.
 */
export function detectFormat(header: Uint8Array): DvFormat | null {
  if (header.length < 4) return null;
  // SCT (Section Type) lives in bits 7-5 of ID0. Header section is SCT=0.
  const sct = (header[0]! >>> 5) & 0x7;
  if (sct !== 0) return null;
  // DSF: bit 7 of byte 3 (first payload byte). 0 = 525/60 (NTSC), 1 = 625/50 (PAL).
  const dsf = (header[3]! >>> 7) & 0x1;
  if (dsf === 0) {
    return { system: 'ntsc', frameSize: FRAME_SIZE_NTSC, fps: FPS_NTSC };
  }
  return { system: 'pal', frameSize: FRAME_SIZE_PAL, fps: FPS_PAL };
}

function bcd(b: number): number {
  return (b & 0x0f) + ((b >>> 4) & 0x0f) * 10;
}

function parseRecDate(pack: Uint8Array): { year: number; month: number; day: number } | null {
  // PC2 = day (BCD, upper bits reserved/weekday)
  // PC3 = month (BCD low 5 bits, weekday in upper bits)
  // PC4 = year (BCD, full byte)
  const day = bcd(pack[2]! & 0x3f);
  const month = bcd(pack[3]! & 0x1f);
  const yearBcd = bcd(pack[4]!);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Spec-defined year mapping: 75-99 -> 1975-1999, 00-74 -> 2000-2074.
  const year = yearBcd >= 75 ? 1900 + yearBcd : 2000 + yearBcd;
  return { year, month, day };
}

function parseRecTime(pack: Uint8Array): { hour: number; minute: number; second: number } | null {
  // PC1 = frames (ignored), PC2 = seconds, PC3 = minutes, PC4 = hours (all BCD)
  const second = bcd(pack[2]! & 0x7f);
  const minute = bcd(pack[3]! & 0x7f);
  const hour = bcd(pack[4]! & 0x3f);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

/**
 * Scan a DV frame (or any prefix of one) for the VAUX rec-date + rec-time
 * packs. We can't assume both packs live in the first DIF sequence — different
 * writers spread them across sequences — so we walk every complete sequence
 * we have until both are found.
 *
 * VAUX lives in blocks 3-5 of each sequence; each block's 77-byte payload
 * holds 15 packs of 5 bytes, so we iterate at 5-byte boundaries checking
 * each pack header.
 */
export function extractTimestamp(data: Uint8Array): DvTimestamp | null {
  // Sanity check: scanning random bytes will produce false positives because
  // 0x62/0x63 are common byte values and BCD parsing accepts a wide range. So
  // first confirm this actually looks like a DV frame — the Header DIF block
  // ID at the very start should be `1f 07 00 ..`.
  if (data.length < 4 || data[0] !== 0x1f || data[1] !== 0x07 || data[2] !== 0x00) {
    return null;
  }

  let date: { year: number; month: number; day: number } | null = null;
  let time: { hour: number; minute: number; second: number } | null = null;

  const sequences = Math.max(1, Math.floor(data.length / DIF_SEQUENCE_SIZE));

  for (let s = 0; s < sequences; s++) {
    const seqStart = s * DIF_SEQUENCE_SIZE;
    for (let blockIdx = 3; blockIdx <= 5; blockIdx++) {
      const blockStart = seqStart + blockIdx * DIF_BLOCK_SIZE;
      if (blockStart + DIF_BLOCK_SIZE > data.length) break;
      for (let i = blockStart + 3; i + 5 <= blockStart + DIF_BLOCK_SIZE; i += 5) {
        const header = data[i]!;
        if (!date && header === PACK_VAUX_REC_DATE) {
          date = parseRecDate(data.subarray(i, i + 5));
        } else if (!time && header === PACK_VAUX_REC_TIME) {
          time = parseRecTime(data.subarray(i, i + 5));
        }
        if (date && time) return { ...date, ...time };
      }
    }
  }
  return date && time ? { ...date, ...time } : null;
}

/**
 * Scan a raw byte run (typically an MPEG-2 user_data section from an HDV
 * stream) for the same 5-byte rec-date / rec-time packs DV uses. Unlike
 * `extractTimestamp` this does not require a DV header at the start — the
 * caller has already located the user_data region, and we just iterate
 * every byte position looking for 0x62 / 0x63 followed by BCD that parses
 * to a valid date and time. Random-byte false positives are unlikely
 * because parseRecDate / parseRecTime reject invalid ranges.
 */
export function extractHdvTimestamp(userData: Uint8Array): DvTimestamp | null {
  let date: { year: number; month: number; day: number } | null = null;
  let time: { hour: number; minute: number; second: number } | null = null;
  for (let i = 0; i + 5 <= userData.length; i++) {
    const h = userData[i]!;
    if (!date && h === PACK_VAUX_REC_DATE) {
      const d = parseRecDate(userData.subarray(i, i + 5));
      if (d) date = d;
    } else if (!time && h === PACK_VAUX_REC_TIME) {
      const t = parseRecTime(userData.subarray(i, i + 5));
      if (t) time = t;
    }
    if (date && time) break;
  }
  return date && time ? { ...date, ...time } : null;
}
