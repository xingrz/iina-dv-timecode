// Tiny binary read helpers. All access patterns assume bounds were checked by
// the caller; we use non-null assertions to keep the call sites tidy under
// noUncheckedIndexedAccess.

export function read4cc(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(buf[offset]!, buf[offset + 1]!, buf[offset + 2]!, buf[offset + 3]!);
}

export function readU16LE(buf: Uint8Array, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8);
}

export function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    buf[offset]! |
    (buf[offset + 1]! << 8) |
    (buf[offset + 2]! << 16) |
    (buf[offset + 3]! << 24)
  ) >>> 0;
}

export function readU64LE(buf: Uint8Array, offset: number): number {
  const lo = readU32LE(buf, offset);
  const hi = readU32LE(buf, offset + 4);
  return hi * 0x100000000 + lo;
}

export function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! << 24) |
    (buf[offset + 1]! << 16) |
    (buf[offset + 2]! << 8) |
    buf[offset + 3]!
  ) >>> 0;
}

export function readU64BE(buf: Uint8Array, offset: number): number {
  // Returns a JS number; precise up to 2^53, which covers any plausible
  // single-file offset (8 PiB). co64 atoms in QuickTime are 64-bit but
  // real-world files never approach that range.
  const hi = readU32BE(buf, offset);
  const lo = readU32BE(buf, offset + 4);
  return hi * 0x100000000 + lo;
}

export function fileSize(handle: IINA.API.FileHandle): number {
  handle.seekToEnd();
  return handle.offset();
}
