import { detectFormat, DvFormat, extractTimestamp } from '../dv';
import { fileSize, read4cc, readU32BE, readU64BE } from '../io';
import { Source } from './types';

// QuickTime sample description (codec) FourCCs for DV variants.
const DV_CODECS = new Set(['dvc ', 'dvcp', 'dvpp', 'dv5n', 'dv5p']);

interface Atom {
  type: string;
  payloadStart: number;
  end: number;
}

/**
 * DV inside QuickTime (.mov / .qt). Walks atoms to find the video trak with
 * a DV codec, then builds a sample-offset table from stco/co64 + stsc + stsz.
 */
export function openMov(handle: IINA.API.FileHandle): Source | null {
  const fileLen = fileSize(handle);
  const moov = findAtom(handle, 0, fileLen, 'moov');
  if (!moov) {
    handle.close();
    return null;
  }

  const stbl = findDvVideoTrackStbl(handle, moov);
  if (!stbl) {
    handle.close();
    return null;
  }

  // The stbl atom holds the sample tables (stco/co64/stsc/stsz). Read it once
  // into memory and parse there — far cheaper than seeking around per atom.
  const stblPayload = readRange(handle, stbl.payloadStart, stbl.end);
  if (!stblPayload) {
    handle.close();
    return null;
  }

  const offsets = buildSampleOffsets(stblPayload);
  if (!offsets || offsets.length === 0) {
    handle.close();
    return null;
  }

  handle.seekTo(offsets[0]!);
  const dvHead = handle.read(4);
  if (!dvHead) {
    handle.close();
    return null;
  }
  const format: DvFormat | null = detectFormat(dvHead);
  if (!format) {
    handle.close();
    return null;
  }

  return {
    timestampAt(positionSec) {
      const frameIdx = Math.max(0, Math.floor(positionSec * format.fps));
      if (frameIdx >= offsets.length) return null;
      handle.seekTo(offsets[frameIdx]!);
      const buf = handle.read(format.frameSize);
      return buf && buf.length > 0 ? extractTimestamp(buf) : null;
    },
    close() {
      try { handle.close(); } catch { /* ignore */ }
    },
  };
}

function readAtomHeader(
  handle: IINA.API.FileHandle,
  pos: number,
  parentEnd: number,
): Atom | null {
  if (pos + 8 > parentEnd) return null;
  handle.seekTo(pos);
  const h = handle.read(8);
  if (!h || h.length < 8) return null;
  let size = readU32BE(h, 0);
  const type = read4cc(h, 4);
  let payloadStart = pos + 8;
  if (size === 1) {
    const big = handle.read(8);
    if (!big || big.length < 8) return null;
    size = readU64BE(big, 0);
    payloadStart = pos + 16;
  } else if (size === 0) {
    // Spec: size 0 means "to end of file/parent".
    size = parentEnd - pos;
  }
  return { type, payloadStart, end: pos + size };
}

function findAtom(
  handle: IINA.API.FileHandle,
  start: number,
  end: number,
  type: string,
): Atom | null {
  let pos = start;
  while (pos < end) {
    const a = readAtomHeader(handle, pos, end);
    if (!a || a.end <= pos) return null;
    if (a.type === type) return a;
    pos = a.end;
  }
  return null;
}

function findChild(handle: IINA.API.FileHandle, parent: Atom, type: string): Atom | null {
  return findAtom(handle, parent.payloadStart, parent.end, type);
}

function findDvVideoTrackStbl(handle: IINA.API.FileHandle, moov: Atom): Atom | null {
  let pos = moov.payloadStart;
  while (pos < moov.end) {
    const trak = readAtomHeader(handle, pos, moov.end);
    if (!trak || trak.end <= pos) return null;
    if (trak.type === 'trak') {
      const mdia = findChild(handle, trak, 'mdia');
      if (mdia) {
        const minf = findChild(handle, mdia, 'minf');
        if (minf) {
          const stbl = findChild(handle, minf, 'stbl');
          if (stbl) {
            const stsd = findChild(handle, stbl, 'stsd');
            if (stsd && stsdHasDvCodec(handle, stsd)) {
              return stbl;
            }
          }
        }
      }
    }
    pos = trak.end;
  }
  return null;
}

function stsdHasDvCodec(handle: IINA.API.FileHandle, stsd: Atom): boolean {
  // stsd payload layout: 1 byte version + 3 bytes flags + 4 bytes entry count
  // + N entries. Each entry begins with `4 bytes size + 4 bytes type`.
  handle.seekTo(stsd.payloadStart);
  const head = handle.read(8);
  if (!head || head.length < 8) return false;
  const entryCount = readU32BE(head, 4);
  let pos = stsd.payloadStart + 8;
  for (let i = 0; i < entryCount; i++) {
    if (pos + 8 > stsd.end) return false;
    handle.seekTo(pos);
    const eh = handle.read(8);
    if (!eh || eh.length < 8) return false;
    const size = readU32BE(eh, 0);
    if (size <= 0) return false;
    const type = read4cc(eh, 4);
    if (DV_CODECS.has(type)) return true;
    pos += size;
  }
  return false;
}

function readRange(
  handle: IINA.API.FileHandle,
  start: number,
  end: number,
): Uint8Array | null {
  const len = end - start;
  // Safety cap: stbl for ~4 hours of DV is a couple MB. 64 MB is way more
  // than any reasonable real file would need; anything larger is suspicious.
  if (len <= 0 || len > 64 * 1024 * 1024) return null;
  handle.seekTo(start);
  const buf = handle.read(len);
  return buf && buf.length === len ? buf : null;
}

interface StscEntry { firstChunk: number; samplesPerChunk: number }
interface StszInfo { defaultSize: number; sizes: Uint32Array | null }

function buildSampleOffsets(stbl: Uint8Array): number[] | null {
  let stsc: StscEntry[] | null = null;
  let stsz: StszInfo | null = null;
  let chunkOffsets: number[] | null = null;

  // Walk top-level child atoms within the stbl payload.
  let pos = 0;
  while (pos + 8 <= stbl.length) {
    const size = readU32BE(stbl, pos);
    const type = read4cc(stbl, pos + 4);
    if (size < 8 || pos + size > stbl.length) break;
    const payloadStart = pos + 8;
    const payloadEnd = pos + size;

    if (type === 'stsc') stsc = parseStsc(stbl, payloadStart, payloadEnd);
    else if (type === 'stsz') stsz = parseStsz(stbl, payloadStart, payloadEnd);
    else if (type === 'stco') chunkOffsets = parseStco(stbl, payloadStart, payloadEnd);
    else if (type === 'co64') chunkOffsets = parseCo64(stbl, payloadStart, payloadEnd);

    pos = payloadEnd;
  }

  if (!stsc || !stsz || !chunkOffsets) return null;
  return computeSampleOffsets(stsc, stsz, chunkOffsets);
}

function parseStsc(buf: Uint8Array, start: number, end: number): StscEntry[] {
  // 4 bytes version+flags, 4 bytes entry count, then 12 bytes per entry.
  const count = readU32BE(buf, start + 4);
  const out: StscEntry[] = [];
  let p = start + 8;
  for (let i = 0; i < count && p + 12 <= end; i++) {
    out.push({
      firstChunk: readU32BE(buf, p),
      samplesPerChunk: readU32BE(buf, p + 4),
    });
    p += 12;
  }
  return out;
}

function parseStsz(buf: Uint8Array, start: number, end: number): StszInfo {
  // 4 bytes version+flags, 4 bytes default sample size, 4 bytes sample count.
  // If default size > 0, all samples are that size; otherwise per-sample sizes follow.
  const defaultSize = readU32BE(buf, start + 4);
  const count = readU32BE(buf, start + 8);
  if (defaultSize > 0) return { defaultSize, sizes: null };
  const sizes = new Uint32Array(count);
  let p = start + 12;
  for (let i = 0; i < count && p + 4 <= end; i++) {
    sizes[i] = readU32BE(buf, p);
    p += 4;
  }
  return { defaultSize: 0, sizes };
}

function parseStco(buf: Uint8Array, start: number, end: number): number[] {
  const count = readU32BE(buf, start + 4);
  const out: number[] = [];
  let p = start + 8;
  for (let i = 0; i < count && p + 4 <= end; i++) {
    out.push(readU32BE(buf, p));
    p += 4;
  }
  return out;
}

function parseCo64(buf: Uint8Array, start: number, end: number): number[] {
  const count = readU32BE(buf, start + 4);
  const out: number[] = [];
  let p = start + 8;
  for (let i = 0; i < count && p + 8 <= end; i++) {
    out.push(readU64BE(buf, p));
    p += 8;
  }
  return out;
}

function computeSampleOffsets(
  stsc: StscEntry[],
  stsz: StszInfo,
  chunkOffsets: number[],
): number[] {
  const result: number[] = [];
  let stscIdx = 0;
  let sampleIdx = 0;

  for (let chunkIdx = 0; chunkIdx < chunkOffsets.length; chunkIdx++) {
    // stsc `firstChunk` is 1-based; advance to the entry covering this chunk.
    while (
      stscIdx + 1 < stsc.length &&
      stsc[stscIdx + 1]!.firstChunk - 1 <= chunkIdx
    ) {
      stscIdx++;
    }
    const samplesPerChunk = stsc[stscIdx]?.samplesPerChunk ?? 0;
    let offsetInChunk = 0;
    for (let s = 0; s < samplesPerChunk; s++) {
      result.push(chunkOffsets[chunkIdx]! + offsetInChunk);
      const sampleSize =
        stsz.defaultSize > 0 ? stsz.defaultSize : (stsz.sizes?.[sampleIdx] ?? 0);
      offsetInChunk += sampleSize;
      sampleIdx++;
    }
  }

  return result;
}
