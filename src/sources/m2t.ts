import { extractHdvTimestamp, DvTimestamp } from '../dv';
import { fileSize } from '../io';
import { Source } from './types';

// HDV inside MPEG-TS. Many extensions live on top of this same container:
//   .m2t, .ts                       — standard 188-byte TS
//   .m2ts, .mts                     — BDAV 192-byte TS (4-byte timestamp
//                                     prefix in front of every 188-byte
//                                     packet)
//   .mpg, .mpeg                     — also seen in the wild as 188-byte TS
//                                     (despite the name suggesting PS)
// We auto-detect framing by looking for the 0x47 sync byte at two
// consecutive 188- or 192-byte intervals near the start of the file. Some
// captures (e.g. Premiere's Windows DV/HDV exports) have a few dozen bytes
// of leading garbage before the first sync, which the detector also tolerates.
//
// Sony HDV (HVR-Z*, HDR-FX*, etc.) writes camera metadata to a dedicated
// private TS stream identified by stream_type 0xA1 in the PMT. Each AUX
// PES packet carries, at fixed offsets from a 0x63 anchor:
//   - 0xC0 rec_date pack (year/month/day in BCD, Sony's ID instead of
//     DV's 0x62 but same bit layout)
//   - wall-clock time as BCD `SS MM HH` — note REVERSED byte order from
//     DV's `HH MM SS` rec_time pack. Cross-verified against mediainfo's
//     `Encoded_Date` field across multiple files.
//
// Other HDV writers (JVC, Canon) instead embed packs in MPEG-2 user_data
// (00 00 01 B2) sections after each GOP, the way HDV-PS originally
// specified. We try that as a fallback if no AUX stream is found, though
// only date — not wall-clock — survives that path.

const SYNC_BYTE = 0x47;
const TS_PACKET_SIZE = 188; // bytes per actual TS packet payload+header
// A 1 MB window is ~0.3 s of HDV stream and contains multiple AUX packets.
const AUX_WINDOW = 1024 * 1024;
// 4 MB is big enough to span one MPEG-2 GOP in the fallback path.
const VIDEO_WINDOW = 4 * 1024 * 1024;
const CACHE_THRESHOLD_SEC = 0.5;

/**
 * TS packets can be 188-byte (standard) or 192-byte (BDAV, with a 4-byte
 * timestamp prefix before each 188-byte payload). Either way, the sync byte
 * 0x47 starts each TS packet, just at differing strides.
 */
interface Framing {
  stride: number; // 188 or 192
  firstSync: number; // file offset of the first sync byte
}

export function openM2t(handle: IINA.API.FileHandle): Source | null {
  const fileLen = fileSize(handle);
  if (fileLen < TS_PACKET_SIZE * 16) {
    handle.close();
    return null;
  }

  handle.seekTo(0);
  const probe = handle.read(2048);
  const framing = probe ? detectFraming(probe) : null;
  if (!framing) {
    handle.close();
    return null;
  }

  const pids = findStreamPids(handle, framing);
  if (pids.auxPid === null && pids.videoPid === null) {
    handle.close();
    return null;
  }

  if (pids.auxPid !== null) {
    const fps = pids.videoPid !== null
      ? detectHdvFps(handle, fileLen, framing, pids.videoPid)
      : null;
    return makeAuxSource(handle, fileLen, framing, pids.auxPid, fps);
  }
  return makeVideoUserDataSource(handle, fileLen, framing, pids.videoPid!);
}

function detectFraming(probe: Uint8Array): Framing | null {
  // Three consecutive sync bytes at a constant stride uniquely identifies
  // the framing. Some files have leading garbage (e.g. mid-packet truncation
  // at the start), so we scan a couple hundred bytes for the first match.
  const maxStart = Math.min(256, probe.length - 384);
  for (let start = 0; start < maxStart; start++) {
    if (probe[start] !== SYNC_BYTE) continue;
    if (probe[start + 188] === SYNC_BYTE && probe[start + 376] === SYNC_BYTE) {
      return { stride: 188, firstSync: start };
    }
    if (probe[start + 192] === SYNC_BYTE && probe[start + 384] === SYNC_BYTE) {
      return { stride: 192, firstSync: start };
    }
  }
  return null;
}

/** Snap an arbitrary file offset down to the nearest packet boundary. */
function alignToPacket(approxOffset: number, framing: Framing): number {
  if (approxOffset <= framing.firstSync) return framing.firstSync;
  const relative = approxOffset - framing.firstSync;
  return framing.firstSync + Math.floor(relative / framing.stride) * framing.stride;
}

function estimateWindowOffset(
  positionSec: number,
  durationSec: number,
  fileLen: number,
  framing: Framing,
  windowSize: number,
): number {
  const est = Math.floor((positionSec / durationSec) * fileLen);
  const maxStart = Math.max(framing.firstSync, fileLen - windowSize);
  const clamped = Math.max(framing.firstSync, Math.min(est, maxStart));
  return alignToPacket(clamped, framing);
}

// ---- Sony HDV: extract timestamp from AUX PES packets ----

function makeAuxSource(
  handle: IINA.API.FileHandle,
  fileLen: number,
  framing: Framing,
  auxPid: number,
  fps: number | null,
): Source {
  // PAL HDV runs 25 fps (frame field 0-24), NTSC ~29.97 (0-29). `wrap` is the
  // frame modulus; `fps` (the real rate) drives interpolation between reads.
  const wrap = fps ? Math.round(fps) : 0;

  let cachedPos = -1;
  let cachedTs: DvTimestamp | null = null;
  // Anchor for per-frame interpolation: the decoded tape TC expressed as a
  // total frame count, plus the playback position it was read at. -1 = none.
  let anchorFrames = -1;
  let anchorPos = 0;
  // Whether the most recent re-anchor read found AUX data. False across a
  // dropout (e.g. tape-end garbage) so we report null instead of free-running
  // a fabricated timecode off a stale anchor.
  let dataPresent = false;

  function decode(positionSec: number, durationSec: number): DvTimestamp | null {
    const aligned = estimateWindowOffset(positionSec, durationSec, fileLen, framing, AUX_WINDOW);
    handle.seekTo(aligned);
    const win = handle.read(Math.min(AUX_WINDOW, fileLen - aligned));
    if (!win) return null;

    for (let pos = 0; pos + TS_PACKET_SIZE <= win.length; pos += framing.stride) {
      if (win[pos] !== SYNC_BYTE) continue;
      const b1 = win[pos + 1]!;
      const pid = ((b1 & 0x1f) << 8) | win[pos + 2]!;
      if (pid !== auxPid) continue;
      if (((b1 >> 6) & 1) === 0) continue;
      const payloadStart = tsPayloadStart(win, pos);
      if (payloadStart === null) continue;
      const payload = win.subarray(payloadStart, pos + TS_PACKET_SIZE);
      const ts = decodeAuxPes(payload);
      if (ts) return ts;
    }
    return null;
  }

  const source: Source = {
    timestampAt(positionSec, durationSec) {
      if (!durationSec || durationSec <= 0) return dataPresent ? cachedTs : null;

      // Hit the disk only every CACHE_THRESHOLD_SEC of playback; that read
      // re-anchors the wall-clock and the interpolation baseline. Advance
      // cachedPos even when nothing is found (a tape-end dropout) so we don't
      // re-scan every tick, and track dataPresent so the overlay can show a
      // "data lost" placeholder instead of a frozen or fabricated value.
      if (cachedPos < 0 || Math.abs(positionSec - cachedPos) >= CACHE_THRESHOLD_SEC) {
        cachedPos = positionSec;
        const ts = decode(positionSec, durationSec);
        dataPresent = ts !== null;
        if (ts) {
          cachedTs = ts;
          anchorPos = positionSec;
          anchorFrames = fps && ts.tcHour !== undefined ? tcToFrames(ts, wrap) : -1;
        }
      }
      if (!dataPresent || !cachedTs) return null;

      // Between reads, advance the tape TC from the anchor using the player
      // clock. Within a take the TC tracks playback exactly, so this stays
      // frame-accurate; the next read re-anchors across any discontinuity.
      if (fps && anchorFrames >= 0) {
        const total = Math.max(0, anchorFrames + Math.round((positionSec - anchorPos) * fps));
        return { ...cachedTs, ...framesToTc(total, wrap) };
      }
      return cachedTs;
    },
    close() {
      try { handle.close(); } catch { /* ignore */ }
    },
  };
  // With a known frame rate, refresh at frame cadence so the interpolated tape
  // TC advances one frame at a time; otherwise the default poll rate is plenty
  // for the second-resolution wall-clock.
  if (fps) source.updateIntervalMs = Math.round(1000 / fps);
  return source;
}

/**
 * Read the MPEG-2 sequence header's frame_rate_code from the video ES so the
 * AUX source can interpolate the tape timecode at the right cadence (25 fps
 * PAL / 29.97 NTSC). Returns null if no sequence header turns up in the first
 * window, in which case the source falls back to coarse per-read TC.
 */
function detectHdvFps(
  handle: IINA.API.FileHandle,
  fileLen: number,
  framing: Framing,
  videoPid: number,
): number | null {
  handle.seekTo(framing.firstSync);
  const win = handle.read(Math.min(VIDEO_WINDOW, fileLen - framing.firstSync));
  if (!win) return null;
  const es = demuxVideoEs(win, framing, videoPid);
  for (let i = 0; i + 8 <= es.length; i++) {
    // sequence_header_code 00 00 01 B3, then 12b width + 12b height + 4b aspect
    // + 4b frame_rate_code — the rate nibble lands in the low bits of byte 7.
    if (es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 1 && es[i + 3] === 0xb3) {
      return MPEG2_FRAME_RATES[es[i + 7]! & 0x0f] ?? null;
    }
  }
  return null;
}

// MPEG-2 frame_rate_code table (ISO/IEC 13818-2, Table 6-4).
const MPEG2_FRAME_RATES: Record<number, number> = {
  1: 24000 / 1001,
  2: 24,
  3: 25,
  4: 30000 / 1001,
  5: 30,
  6: 50,
  7: 60000 / 1001,
  8: 60,
};

function tcToFrames(ts: DvTimestamp, wrap: number): number {
  return ((ts.tcHour! * 60 + ts.tcMinute!) * 60 + ts.tcSecond!) * wrap + ts.tcFrame!;
}

function framesToTc(
  total: number,
  wrap: number,
): { tcHour: number; tcMinute: number; tcSecond: number; tcFrame: number } {
  const tcFrame = total % wrap;
  const totalSeconds = Math.floor(total / wrap);
  const tcSecond = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const tcMinute = totalMinutes % 60;
  const tcHour = Math.floor(totalMinutes / 60) % 24;
  return { tcHour, tcMinute, tcSecond, tcFrame };
}

function decodeAuxPes(payload: Uint8Array): DvTimestamp | null {
  // PES header: 00 00 01 BF length(2)
  if (
    payload.length < 8 ||
    payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1 || payload[3] !== 0xbf
  ) {
    return null;
  }
  return scanForHdvAuxPacks(payload.subarray(6));
}

/**
 * Sony HDV-AUX (TSHV) PES payload carries, at fixed relative offsets from a
 * 0x63 SMPTE-timecode pack header:
 *
 *   +0..4    0x63 + 4 bytes tape SMPTE timecode (rec-run, HH FF SS MM) —
 *            frame-accurate, decoded into tc*; independent of the wall-clock
 *   +5..9    0xC0 + 4 bytes BCD rec_date (tz, day, month, year)
 *   +10      0xFF separator
 *   +11..13  BCD wall-clock SS MM HH (reversed from DV's HH MM SS order)
 *   +14      frame count or padding
 *
 * Verified against mediainfo's `Encoded_Date` field on multiple files —
 * matches exactly. The combined `63 ?? ?? ?? ?? c0 ?? ?? ?? ?? ff` anchor
 * is specific enough that random payload bytes won't false-match.
 */
function scanForHdvAuxPacks(body: Uint8Array): DvTimestamp | null {
  for (let i = 0; i + 14 <= body.length; i++) {
    if (body[i] !== 0x63) continue;
    if (body[i + 5] !== 0xc0) continue;
    if (body[i + 10] !== 0xff) continue;
    const date = parseSonyHdvRecDate(body, i + 5);
    if (!date) continue;
    // Frame-accurate tape timecode lives in the 0x63 pack itself; it's rec-run
    // and independent of the wall-clock, so decode it separately and let either
    // be absent without dropping the other.
    const tc = parseSonyHdvTimecode(body, i);
    const second = bcd(body[i + 11]! & 0x7f);
    const minute = bcd(body[i + 12]! & 0x7f);
    const hour = bcd(body[i + 13]! & 0x3f);
    const clock = second > 59 || minute > 59 || hour > 23 ? null : { hour, minute, second };
    if (!clock && !tc) return date;
    return { ...date, ...clock, ...tc };
  }
  return null;
}

function parseSonyHdvTimecode(
  body: Uint8Array,
  i: number,
): { tcHour: number; tcMinute: number; tcSecond: number; tcFrame: number } | null {
  // The 0x63 pack's four data bytes are the tape SMPTE timecode, byte order
  // HH FF SS MM (flag bits masked off).
  const tcHour = bcd(body[i + 1]! & 0x3f);
  const tcFrame = bcd(body[i + 2]! & 0x3f);
  const tcSecond = bcd(body[i + 3]! & 0x7f);
  const tcMinute = bcd(body[i + 4]! & 0x7f);
  // 29 covers NTSC's 30-frame wrap; PAL wraps at 25. Reject anything past it.
  if (tcHour > 23 || tcMinute > 59 || tcSecond > 59 || tcFrame > 29) return null;
  return { tcHour, tcMinute, tcSecond, tcFrame };
}

function bcd(b: number): number {
  return (b & 0x0f) + ((b >>> 4) & 0x0f) * 10;
}

function parseSonyHdvRecDate(body: Uint8Array, i: number): { year: number; month: number; day: number } | null {
  // Same BCD layout as DV's 0x62 pack — just a different pack ID.
  const day = bcd(body[i + 2]! & 0x3f);
  const month = bcd(body[i + 3]! & 0x1f);
  const yearBcd = bcd(body[i + 4]!);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = yearBcd >= 75 ? 1900 + yearBcd : 2000 + yearBcd;
  return { year, month, day };
}

// ---- JVC/Canon HDV fallback: scan MPEG-2 user_data after GOP headers ----

function makeVideoUserDataSource(
  handle: IINA.API.FileHandle,
  fileLen: number,
  framing: Framing,
  videoPid: number,
): Source {
  let cachedPos = -1;
  let cachedTs: DvTimestamp | null = null;

  return {
    timestampAt(positionSec, durationSec) {
      if (!durationSec || durationSec <= 0) return cachedTs;
      if (cachedTs && Math.abs(positionSec - cachedPos) < CACHE_THRESHOLD_SEC) {
        return cachedTs;
      }

      const aligned = estimateWindowOffset(positionSec, durationSec, fileLen, framing, VIDEO_WINDOW);
      handle.seekTo(aligned);
      const win = handle.read(Math.min(VIDEO_WINDOW, fileLen - aligned));
      if (!win || win.length < TS_PACKET_SIZE * 16) return cachedTs;

      const es = demuxVideoEs(win, framing, videoPid);
      if (es.length === 0) return cachedTs;

      const ts = findGopUserDataAndExtract(es);
      if (ts) {
        cachedPos = positionSec;
        cachedTs = ts;
      }
      return ts ?? cachedTs;
    },
    close() {
      try { handle.close(); } catch { /* ignore */ }
    },
  };
}

// ---- Common TS demux primitives ----

interface StreamPids { auxPid: number | null; videoPid: number | null }

function findStreamPids(handle: IINA.API.FileHandle, framing: Framing): StreamPids {
  // PAT/PMT can take tens of thousands of packets to refresh in 25 Mbps HDV.
  const SCAN_BYTES = 4 * 1024 * 1024;
  handle.seekTo(framing.firstSync);
  const buf = handle.read(SCAN_BYTES);
  if (!buf) return { auxPid: null, videoPid: null };

  let pmtPid: number | null = null;
  let auxPid: number | null = null;
  let videoPid: number | null = null;
  for (let pos = 0; pos + TS_PACKET_SIZE <= buf.length; pos += framing.stride) {
    if (buf[pos] !== SYNC_BYTE) continue;
    const b1 = buf[pos + 1]!;
    const pid = ((b1 & 0x1f) << 8) | buf[pos + 2]!;
    if (((b1 >> 6) & 1) === 0) continue;
    const payloadStart = tsPayloadStart(buf, pos);
    if (payloadStart === null) continue;

    if (pid === 0 && pmtPid === null) {
      pmtPid = parsePat(buf, payloadStart, pos + TS_PACKET_SIZE);
    } else if (pmtPid !== null && pid === pmtPid && auxPid === null && videoPid === null) {
      const found = parsePmt(buf, payloadStart, pos + TS_PACKET_SIZE);
      if (found) {
        auxPid = found.auxPid;
        videoPid = found.videoPid;
        if (auxPid !== null || videoPid !== null) break;
      }
    }
  }
  return { auxPid, videoPid };
}

function tsPayloadStart(buf: Uint8Array, pos: number): number | null {
  const adapt = (buf[pos + 3]! >> 4) & 0x3;
  if (adapt !== 1 && adapt !== 3) return null;
  let payloadStart = pos + 4;
  if (adapt === 3) {
    const adaptLen = buf[pos + 4]!;
    payloadStart = pos + 5 + adaptLen;
  }
  return payloadStart < pos + TS_PACKET_SIZE ? payloadStart : null;
}

function parsePat(buf: Uint8Array, payloadStart: number, packetEnd: number): number | null {
  const pointer = buf[payloadStart]!;
  const tableStart = payloadStart + 1 + pointer;
  if (tableStart + 8 > packetEnd) return null;
  if (buf[tableStart] !== 0x00) return null;
  const sectionLength = ((buf[tableStart + 1]! & 0x0f) << 8) | buf[tableStart + 2]!;
  let p = tableStart + 8;
  const end = Math.min(tableStart + 3 + sectionLength - 4, packetEnd);
  while (p + 4 <= end) {
    const programNumber = (buf[p]! << 8) | buf[p + 1]!;
    const pid = ((buf[p + 2]! & 0x1f) << 8) | buf[p + 3]!;
    if (programNumber !== 0) return pid;
    p += 4;
  }
  return null;
}

function parsePmt(buf: Uint8Array, payloadStart: number, packetEnd: number): StreamPids | null {
  const pointer = buf[payloadStart]!;
  const tableStart = payloadStart + 1 + pointer;
  if (tableStart + 12 > packetEnd) return null;
  if (buf[tableStart] !== 0x02) return null;
  const sectionLength = ((buf[tableStart + 1]! & 0x0f) << 8) | buf[tableStart + 2]!;
  const programInfoLength = ((buf[tableStart + 10]! & 0x0f) << 8) | buf[tableStart + 11]!;
  let p = tableStart + 12 + programInfoLength;
  const end = Math.min(tableStart + 3 + sectionLength - 4, packetEnd);
  // Prefer Sony's 0xA1 (HDV-AUX2) over 0xA0; in observed files only 0xA1
  // carries the rec_date pack, while 0xA0 only has PCR-style timing data.
  let auxA1: number | null = null;
  let auxA0: number | null = null;
  let videoPid: number | null = null;
  while (p + 5 <= end) {
    const streamType = buf[p]!;
    const pid = ((buf[p + 1]! & 0x1f) << 8) | buf[p + 2]!;
    const esInfoLength = ((buf[p + 3]! & 0x0f) << 8) | buf[p + 4]!;
    if (auxA1 === null && streamType === 0xa1) auxA1 = pid;
    if (auxA0 === null && streamType === 0xa0) auxA0 = pid;
    if (videoPid === null && (streamType === 0x01 || streamType === 0x02)) {
      videoPid = pid;
    }
    p += 5 + esInfoLength;
  }
  return { auxPid: auxA1 ?? auxA0, videoPid };
}

// ---- Video PES demux + GOP user_data walker (JVC/Canon fallback) ----

function demuxVideoEs(tsData: Uint8Array, framing: Framing, videoPid: number): Uint8Array {
  const out = new Uint8Array(tsData.length);
  let outLen = 0;
  for (let pos = 0; pos + TS_PACKET_SIZE <= tsData.length; pos += framing.stride) {
    if (tsData[pos] !== SYNC_BYTE) continue;
    const b1 = tsData[pos + 1]!;
    const pid = ((b1 & 0x1f) << 8) | tsData[pos + 2]!;
    if (pid !== videoPid) continue;
    let payloadStart = tsPayloadStart(tsData, pos);
    if (payloadStart === null) continue;
    if (((b1 >> 6) & 1) === 1) {
      if (
        tsData[payloadStart] !== 0 ||
        tsData[payloadStart + 1] !== 0 ||
        tsData[payloadStart + 2] !== 1
      ) continue;
      const pesHeaderLen = tsData[payloadStart + 8]!;
      payloadStart += 9 + pesHeaderLen;
      if (payloadStart >= pos + TS_PACKET_SIZE) continue;
    }
    const payloadEnd = pos + TS_PACKET_SIZE;
    out.set(tsData.subarray(payloadStart, payloadEnd), outLen);
    outLen += payloadEnd - payloadStart;
  }
  return out.subarray(0, outLen);
}

function findGopUserDataAndExtract(es: Uint8Array): DvTimestamp | null {
  let i = 0;
  while (i + 4 <= es.length) {
    if (es[i] !== 0 || es[i + 1] !== 0 || es[i + 2] !== 1 || es[i + 3] !== 0xb8) {
      i++;
      continue;
    }
    let k = i + 8;
    const SCAN_LIMIT = 256;
    while (k + 4 <= es.length && k < i + 8 + SCAN_LIMIT) {
      if (es[k] !== 0 || es[k + 1] !== 0 || es[k + 2] !== 1) {
        k++;
        continue;
      }
      const code = es[k + 3]!;
      if (code === 0xb2) {
        const dataStart = k + 4;
        let dataEnd = es.length;
        for (let m = dataStart; m + 3 <= es.length; m++) {
          if (es[m] === 0 && es[m + 1] === 0 && es[m + 2] === 1) {
            dataEnd = m;
            break;
          }
        }
        const ts = extractHdvTimestamp(es.subarray(dataStart, dataEnd));
        if (ts) return ts;
        break;
      } else if (code === 0xb5) {
        k += 4;
      } else {
        break;
      }
    }
    i += 4;
  }
  return null;
}
