import { extractHdvTimestamp, DvTimestamp } from '../dv';
import { fileSize } from '../io';
import { Source } from './types';

// HDV (.m2t / .ts) — MPEG-2 video inside MPEG-TS. Sony HDV (HVR-Z*,
// HDR-FX*, etc.) writes camera metadata to a dedicated private TS stream
// identified by stream_type 0xA1 in the PMT. Each AUX PES packet carries
// at fixed offsets (relative to a 0x63 anchor):
//   - 0xC0 rec_date pack (year/month/day in BCD, Sony's pack ID instead of
//     DV's 0x62, but same bit layout)
//   - wall-clock time as BCD `SS MM HH` — note REVERSED byte order from
//     DV's `HH MM SS` rec_time pack. Cross-verified against mediainfo's
//     `Encoded_Date` field across multiple files.
//
// Other HDV writers (JVC, Canon) instead embed packs in MPEG-2 user_data
// (00 00 01 B2) sections after each GOP, the way HDV-PS originally
// specified. We try that as a fallback if no AUX stream is found, though
// only date — not wall-clock — survives that path.

const TS_PACKET_SIZE = 188;
const SYNC_BYTE = 0x47;
// A 1 MB window is ~0.3 s of HDV stream and contains multiple AUX packets.
const AUX_WINDOW = 1024 * 1024;
// 4 MB is big enough to span one MPEG-2 GOP in the fallback path.
const VIDEO_WINDOW = 4 * 1024 * 1024;
const CACHE_THRESHOLD_SEC = 0.5;

export function openM2t(handle: IINA.API.FileHandle): Source | null {
  const fileLen = fileSize(handle);
  if (fileLen < TS_PACKET_SIZE * 16) {
    handle.close();
    return null;
  }

  // Verify 188-byte TS framing.
  handle.seekTo(0);
  const probe = handle.read(TS_PACKET_SIZE * 3);
  if (
    !probe || probe.length < TS_PACKET_SIZE * 3 ||
    probe[0] !== SYNC_BYTE ||
    probe[TS_PACKET_SIZE] !== SYNC_BYTE ||
    probe[TS_PACKET_SIZE * 2] !== SYNC_BYTE
  ) {
    handle.close();
    return null;
  }

  const pids = findStreamPids(handle);
  if (pids.auxPid === null && pids.videoPid === null) {
    handle.close();
    return null;
  }

  if (pids.auxPid !== null) {
    return makeAuxSource(handle, fileLen, pids.auxPid);
  }
  return makeVideoUserDataSource(handle, fileLen, pids.videoPid!);
}

// ---- Sony HDV: extract timestamp from AUX PES packets ----

function makeAuxSource(
  handle: IINA.API.FileHandle,
  fileLen: number,
  auxPid: number,
): Source {
  let cachedPos = -1;
  let cachedTs: DvTimestamp | null = null;

  return {
    timestampAt(positionSec, durationSec) {
      if (!durationSec || durationSec <= 0) return cachedTs;
      if (cachedTs && Math.abs(positionSec - cachedPos) < CACHE_THRESHOLD_SEC) {
        return cachedTs;
      }

      const aligned = estimateWindowOffset(handle, positionSec, durationSec, fileLen, AUX_WINDOW);
      if (aligned === null) return cachedTs;

      handle.seekTo(aligned);
      const win = handle.read(Math.min(AUX_WINDOW, fileLen - aligned));
      if (!win) return cachedTs;

      for (let pos = 0; pos + TS_PACKET_SIZE <= win.length; pos += TS_PACKET_SIZE) {
        if (win[pos] !== SYNC_BYTE) continue;
        const b1 = win[pos + 1]!;
        const pid = ((b1 & 0x1f) << 8) | win[pos + 2]!;
        if (pid !== auxPid) continue;
        if (((b1 >> 6) & 1) === 0) continue;
        const payloadStart = tsPayloadStart(win, pos);
        if (payloadStart === null) continue;
        const payload = win.subarray(payloadStart, pos + TS_PACKET_SIZE);
        const ts = decodeAuxPes(payload);
        if (ts) {
          cachedPos = positionSec;
          cachedTs = ts;
          return ts;
        }
      }
      return cachedTs;
    },
    close() {
      try { handle.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * AUX PES packet payload: `00 00 01 BF <length:2>` then private data.
 * Skip the 6-byte PES header and brute-scan the rest for 0xC0 (Sony HDV
 * rec_date) and 0x63 (rec_time) packs. Bit layout matches DV, so
 * `extractHdvTimestamp` would work — except its pack ID set is {0x62, 0x63}.
 * We re-implement the scan here with the HDV pack IDs.
 */
function decodeAuxPes(payload: Uint8Array): DvTimestamp | null {
  // PES header: 00 00 01 BF length(2)
  if (
    payload.length < 8 ||
    payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1 || payload[3] !== 0xbf
  ) {
    return null;
  }
  const body = payload.subarray(6);
  return scanForHdvAuxPacks(body);
}

/**
 * Sony HDV-AUX (TSHV) PES payload carries, at fixed relative offsets from a
 * 0x63 SMPTE-timecode pack header:
 *
 *   +0..4    0x63 + 4 bytes SMPTE timecode (rec-run, ignored — not wall-clock)
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
    const second = bcd(body[i + 11]! & 0x7f);
    const minute = bcd(body[i + 12]! & 0x7f);
    const hour = bcd(body[i + 13]! & 0x3f);
    if (second > 59 || minute > 59 || hour > 23) return date;
    return { ...date, hour, minute, second };
  }
  return null;
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

      const aligned = estimateWindowOffset(handle, positionSec, durationSec, fileLen, VIDEO_WINDOW);
      if (aligned === null) return cachedTs;

      handle.seekTo(aligned);
      const win = handle.read(Math.min(VIDEO_WINDOW, fileLen - aligned));
      if (!win || win.length < TS_PACKET_SIZE * 16) return cachedTs;

      const es = demuxVideoEs(win, videoPid);
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

function findStreamPids(handle: IINA.API.FileHandle): StreamPids {
  // PAT/PMT can take tens of thousands of packets to refresh in 25 Mbps HDV.
  const SCAN_BYTES = 4 * 1024 * 1024;
  handle.seekTo(0);
  const buf = handle.read(SCAN_BYTES);
  if (!buf) return { auxPid: null, videoPid: null };

  let pmtPid: number | null = null;
  let auxPid: number | null = null;
  let videoPid: number | null = null;
  for (let pos = 0; pos + TS_PACKET_SIZE <= buf.length; pos += TS_PACKET_SIZE) {
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
  // Collect candidate PIDs; we prefer Sony's 0xA1 (HDV-AUX2) over 0xA0
  // because in observed files only 0xA1 carries the rec_date pack — 0xA0 is
  // a smaller stream with what looks like PCR-style timing data only.
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

function estimateWindowOffset(
  handle: IINA.API.FileHandle,
  positionSec: number,
  durationSec: number,
  fileLen: number,
  windowSize: number,
): number | null {
  const est = Math.floor((positionSec / durationSec) * fileLen);
  const clamped = Math.max(0, Math.min(est, fileLen - windowSize));
  // Snap to a TS packet boundary so payload offsets line up.
  handle.seekTo(clamped);
  const probe = handle.read(TS_PACKET_SIZE * 2);
  if (!probe || probe.length < TS_PACKET_SIZE * 2) return null;
  for (let i = 0; i < TS_PACKET_SIZE; i++) {
    if (probe[i] === SYNC_BYTE && probe[i + TS_PACKET_SIZE] === SYNC_BYTE) {
      return clamped + i;
    }
  }
  return null;
}

// ---- Video PES demux + GOP user_data walker (JVC/Canon fallback) ----

function demuxVideoEs(tsData: Uint8Array, videoPid: number): Uint8Array {
  const out = new Uint8Array(tsData.length);
  let outLen = 0;
  for (let pos = 0; pos + TS_PACKET_SIZE <= tsData.length; pos += TS_PACKET_SIZE) {
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
