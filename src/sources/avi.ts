import { detectFormat, DvFormat } from '../dv';
import { fileSize, read4cc, readU16LE, readU32LE, readU64LE } from '../io';
import { DvSource } from './types';

/**
 * DV inside RIFF AVI. Handles:
 * - AVI 1.0 (single `RIFF AVI ` chunk, idx1 at end — optional)
 * - OpenDML AVI 2.0 (multiple top-level `RIFF AVIX` segments)
 * - Type 1 (single `iavs` interleaved A/V stream) and Type 2 (`vids`+`auds`)
 *
 * Strategy:
 * 1. Try to parse the OpenDML `indx` super-index in hdrl/strl. It lists the
 *    file offsets of every `ix##` standard chunk index, which in turn give
 *    exact data offsets for every video chunk. ~15 bridge calls total.
 * 2. If no usable indx is found, fall back to walking each `RIFF` segment
 *    and extrapolating from stride between the first two video chunks. This
 *    is only correct for files with uniform chunk layout (some Type 1 DVs).
 *
 * We do NOT walk every chunk linearly — that easily takes 50K+ sync reads
 * through IINA's JS bridge and freezes the player.
 */

interface Segment {
  offsets: number[]; // absolute data offset (= chunk header pos + 8) of each video chunk
}

export function openAvi(handle: IINA.API.FileHandle): DvSource | null {
  const fileLen = fileSize(handle);
  if (fileLen < 12) {
    handle.close();
    return null;
  }

  handle.seekTo(0);
  const head = handle.read(12);
  if (!head || head.length < 12) {
    handle.close();
    return null;
  }
  if (read4cc(head, 0) !== 'RIFF' || read4cc(head, 8) !== 'AVI ') {
    handle.close();
    return null;
  }

  let segments: Segment[] = [];

  // Primary path: parse OpenDML indx super-index + each ix## it points to.
  const superIdx = findVideoSuperIndex(handle, fileLen);
  if (superIdx && superIdx.length > 0) {
    for (const e of superIdx) {
      handle.seekTo(e.offset);
      // Read the ix## chunk including its 8-byte header.
      const buf = handle.read(8 + e.size);
      if (!buf || buf.length < 8 + e.size) continue;
      const id = read4cc(buf, 0);
      if (!id.startsWith('ix')) continue;
      const offsets = parseStandardIndex(buf.subarray(8));
      if (!offsets || offsets.length === 0) continue;
      segments.push({ offsets });
    }
  } else {
    segments = extrapolateFromRiffWalk(handle, fileLen);
  }

  if (segments.length === 0) {
    handle.close();
    return null;
  }

  // Sanity-check the first offset by reading 4 bytes — confirms our index is
  // pointing at real DV data, not 0xFF padding from a wrong interpretation.
  handle.seekTo(segments[0]!.offsets[0]!);
  const dvHead = handle.read(4);
  if (!dvHead || dvHead.length < 4) {
    handle.close();
    return null;
  }
  const format: DvFormat | null = detectFormat(dvHead);
  if (!format) {
    handle.close();
    return null;
  }

  const cum: number[] = [0];
  for (const s of segments) cum.push(cum[cum.length - 1]! + s.offsets.length);
  const total = cum[cum.length - 1]!;

  return {
    format,
    frameCount: total,
    readFrame(frameIdx) {
      if (frameIdx < 0 || frameIdx >= total) return null;
      let segIdx = 0;
      while (segIdx + 1 < cum.length && cum[segIdx + 1]! <= frameIdx) segIdx++;
      const seg = segments[segIdx]!;
      const local = frameIdx - cum[segIdx]!;
      handle.seekTo(seg.offsets[local]!);
      const buf = handle.read(format.frameSize);
      return buf && buf.length > 0 ? buf : null;
    },
    close() {
      try { handle.close(); } catch { /* ignore */ }
    },
  };
}

// ---- OpenDML indx (super-index) + ix## (standard chunk index) parsing ----

interface SuperIndexEntry {
  offset: number; // absolute file offset of an ix## chunk header
  size: number;   // size of that chunk's payload (= its `cb`)
}

/**
 * Walk the first RIFF AVI's hdrl → strl chain looking for the indx super-
 * index of the video stream. Returns the list of ix## chunk locations.
 */
function findVideoSuperIndex(
  handle: IINA.API.FileHandle,
  fileLen: number,
): SuperIndexEntry[] | null {
  handle.seekTo(0);
  const rh = handle.read(12);
  if (!rh || rh.length < 12 || read4cc(rh, 0) !== 'RIFF') return null;
  const riffSize = readU32LE(rh, 4);
  const riffEnd = Math.min(8 + riffSize, fileLen);

  // Find LIST hdrl directly inside the first RIFF.
  const hdrl = findListChild(handle, 12, riffEnd, 'hdrl');
  if (!hdrl) return null;

  // hdrl contains avih, then one or more LIST strl. The strl for the video
  // stream is identified by strh.fccType == "vids" or "iavs".
  let pos = hdrl.dataStart;
  while (pos + 8 <= hdrl.dataEnd) {
    handle.seekTo(pos);
    const ch = handle.read(8);
    if (!ch || ch.length < 8) return null;
    const id = read4cc(ch, 0);
    const size = readU32LE(ch, 4);
    if (id === 'LIST') {
      const lt = handle.read(4);
      if (!lt || lt.length < 4) return null;
      if (read4cc(lt, 0) === 'strl') {
        const result = findIndxInStrl(handle, pos + 12, pos + 8 + size);
        if (result) return result;
      }
    }
    pos += 8 + size + (size & 1);
  }
  return null;
}

interface ListChild { dataStart: number; dataEnd: number }

function findListChild(
  handle: IINA.API.FileHandle,
  start: number,
  end: number,
  listType: string,
): ListChild | null {
  let pos = start;
  while (pos + 8 <= end) {
    handle.seekTo(pos);
    const ch = handle.read(8);
    if (!ch || ch.length < 8) return null;
    const id = read4cc(ch, 0);
    const size = readU32LE(ch, 4);
    if (id === 'LIST') {
      const lt = handle.read(4);
      if (!lt || lt.length < 4) return null;
      if (read4cc(lt, 0) === listType) {
        return { dataStart: pos + 12, dataEnd: pos + 8 + size };
      }
    }
    pos += 8 + size + (size & 1);
  }
  return null;
}

function findIndxInStrl(
  handle: IINA.API.FileHandle,
  start: number,
  end: number,
): SuperIndexEntry[] | null {
  let isVideoStream = false;
  let indxAt: { pos: number; size: number } | null = null;

  let pos = start;
  while (pos + 8 <= end) {
    handle.seekTo(pos);
    const ch = handle.read(8);
    if (!ch || ch.length < 8) return null;
    const id = read4cc(ch, 0);
    const size = readU32LE(ch, 4);
    if (id === 'strh') {
      // First 4 bytes of strh payload are fccType.
      const data = handle.read(4);
      if (data && data.length >= 4) {
        const t = read4cc(data, 0);
        isVideoStream = t === 'vids' || t === 'iavs';
      }
    } else if (id === 'indx') {
      indxAt = { pos: pos + 8, size };
    }
    pos += 8 + size + (size & 1);
  }

  if (!isVideoStream || !indxAt) return null;
  handle.seekTo(indxAt.pos);
  const data = handle.read(indxAt.size);
  if (!data || data.length < indxAt.size) return null;
  return parseSuperIndex(data);
}

/**
 * OpenDML super-index (bIndexType=0): 24-byte header + N * 16-byte entries.
 * Each entry points to one ix## standard chunk index elsewhere in the file.
 */
function parseSuperIndex(data: Uint8Array): SuperIndexEntry[] | null {
  if (data.length < 24) return null;
  const wLongsPerEntry = readU16LE(data, 0);
  const bIndexType = data[3]!;
  const nEntriesInUse = readU32LE(data, 4);
  if (bIndexType !== 0 || wLongsPerEntry !== 4) return null;

  const out: SuperIndexEntry[] = [];
  const max = Math.min(nEntriesInUse, Math.floor((data.length - 24) / 16));
  for (let i = 0; i < max; i++) {
    const p = 24 + i * 16;
    const offset = readU64LE(data, p);
    const size = readU32LE(data, p + 8);
    // entry also has a 4-byte dwDuration we don't need
    out.push({ offset, size });
  }
  return out;
}

/**
 * OpenDML standard chunk index (bIndexType=1): 24-byte header (last 8 bytes
 * are qwBaseOffset) + N * 8-byte entries. Each entry's dwOffset is added to
 * qwBaseOffset to get the absolute data offset of a chunk.
 */
function parseStandardIndex(data: Uint8Array): number[] | null {
  if (data.length < 24) return null;
  const wLongsPerEntry = readU16LE(data, 0);
  const bIndexType = data[3]!;
  const nEntriesInUse = readU32LE(data, 4);
  const chunkId = read4cc(data, 8);
  const baseOffset = readU64LE(data, 12);
  if (bIndexType !== 1 || wLongsPerEntry !== 2) return null;
  if (!isVideoChunk(chunkId)) return null;

  const out: number[] = [];
  const max = Math.min(nEntriesInUse, Math.floor((data.length - 24) / 8));
  for (let i = 0; i < max; i++) {
    const p = 24 + i * 8;
    const dwOffset = readU32LE(data, p);
    out.push(baseOffset + dwOffset);
  }
  return out;
}

// ---- Extrapolation fallback (for files without OpenDML indx) ----

function extrapolateFromRiffWalk(
  handle: IINA.API.FileHandle,
  fileLen: number,
): Segment[] {
  const segments: Segment[] = [];
  let pos = 0;
  while (pos + 12 <= fileLen) {
    handle.seekTo(pos);
    const rh = handle.read(12);
    if (!rh || rh.length < 12) break;
    if (read4cc(rh, 0) !== 'RIFF') break;
    const riffSize = readU32LE(rh, 4);
    const riffType = read4cc(rh, 8);
    if (riffType !== 'AVI ' && riffType !== 'AVIX') break;
    const riffEnd = Math.min(pos + 8 + riffSize, fileLen);

    const movi = findListChild(handle, pos + 12, riffEnd, 'movi');
    if (movi) {
      const seg = extrapolateMovi(handle, movi.dataStart, movi.dataEnd);
      if (seg) segments.push(seg);
    }
    pos = riffEnd + (riffSize & 1);
  }
  return segments;
}

function extrapolateMovi(
  handle: IINA.API.FileHandle,
  start: number,
  end: number,
): Segment | null {
  const first = findNextVideoChunk(handle, start, end);
  if (!first) return null;
  const afterFirst = first.dataOffset + first.size + (first.size & 1);
  const second = findNextVideoChunk(handle, afterFirst, end);
  if (!second) return { offsets: [first.dataOffset] };
  const stride = second.dataOffset - first.dataOffset;
  if (stride <= 0) return null;
  const count = Math.max(1, 1 + Math.floor((end - first.dataOffset - first.size) / stride));
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(first.dataOffset + i * stride);
  return { offsets };
}

function isVideoChunk(id: string): boolean {
  return id.length === 4 && id[2] === 'd' && (id[3] === 'b' || id[3] === 'c');
}

function findNextVideoChunk(
  handle: IINA.API.FileHandle,
  start: number,
  end: number,
): { dataOffset: number; size: number } | null {
  let pos = start;
  for (let guard = 0; guard < 8 && pos + 8 <= end; guard++) {
    handle.seekTo(pos);
    const ch = handle.read(8);
    if (!ch || ch.length < 8) return null;
    const id = read4cc(ch, 0);
    const size = readU32LE(ch, 4);
    if (isVideoChunk(id)) {
      return { dataOffset: pos + 8, size };
    }
    pos += 8 + size + (size & 1);
  }
  return null;
}
