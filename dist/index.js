
//#region \0@oxc-project+runtime@0.132.0/helpers/typeof.js
function _typeof(o) {
	"@babel/helpers - typeof";
	return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o) {
		return typeof o;
	} : function(o) {
		return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o;
	}, _typeof(o);
}

//#endregion
//#region \0@oxc-project+runtime@0.132.0/helpers/toPrimitive.js
function toPrimitive(t, r) {
	if ("object" != _typeof(t) || !t) return t;
	var e = t[Symbol.toPrimitive];
	if (void 0 !== e) {
		var i = e.call(t, r || "default");
		if ("object" != _typeof(i)) return i;
		throw new TypeError("@@toPrimitive must return a primitive value.");
	}
	return ("string" === r ? String : Number)(t);
}

//#endregion
//#region \0@oxc-project+runtime@0.132.0/helpers/toPropertyKey.js
function toPropertyKey(t) {
	var i = toPrimitive(t, "string");
	return "symbol" == _typeof(i) ? i : i + "";
}

//#endregion
//#region \0@oxc-project+runtime@0.132.0/helpers/defineProperty.js
function _defineProperty(e, r, t) {
	return (r = toPropertyKey(r)) in e ? Object.defineProperty(e, r, {
		value: t,
		enumerable: !0,
		configurable: !0,
		writable: !0
	}) : e[r] = t, e;
}

//#endregion
//#region \0@oxc-project+runtime@0.132.0/helpers/objectSpread2.js
function ownKeys(e, r) {
	var t = Object.keys(e);
	if (Object.getOwnPropertySymbols) {
		var o = Object.getOwnPropertySymbols(e);
		r && (o = o.filter(function(r) {
			return Object.getOwnPropertyDescriptor(e, r).enumerable;
		})), t.push.apply(t, o);
	}
	return t;
}
function _objectSpread2(e) {
	for (var r = 1; r < arguments.length; r++) {
		var t = null != arguments[r] ? arguments[r] : {};
		r % 2 ? ownKeys(Object(t), !0).forEach(function(r) {
			_defineProperty(e, r, t[r]);
		}) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function(r) {
			Object.defineProperty(e, r, Object.getOwnPropertyDescriptor(t, r));
		});
	}
	return e;
}

//#endregion
//#region src/dv.ts
const DIF_BLOCK_SIZE = 80;
const DIF_SEQUENCE_SIZE = 12e3;
const FRAME_SIZE_NTSC = 12e4;
const FRAME_SIZE_PAL = 144e3;
const FPS_NTSC = 3e4 / 1001;
const FPS_PAL = 25;
const PACK_VAUX_REC_DATE = 98;
const PACK_VAUX_REC_TIME = 99;
/**
* Detect the DV system (NTSC vs PAL) from the first DIF block (the Header
* section). Returns null if the bytes don't look like a DV header.
*/
function detectFormat(header) {
	if (header.length < 4) return null;
	if ((header[0] >>> 5 & 7) !== 0) return null;
	if ((header[3] >>> 7 & 1) === 0) return {
		system: "ntsc",
		frameSize: FRAME_SIZE_NTSC,
		fps: FPS_NTSC
	};
	return {
		system: "pal",
		frameSize: FRAME_SIZE_PAL,
		fps: 25
	};
}
function bcd$1(b) {
	return (b & 15) + (b >>> 4 & 15) * 10;
}
function parseRecDate(pack) {
	const day = bcd$1(pack[2] & 63);
	const month = bcd$1(pack[3] & 31);
	const yearBcd = bcd$1(pack[4]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	return {
		year: yearBcd >= 75 ? 1900 + yearBcd : 2e3 + yearBcd,
		month,
		day
	};
}
function parseRecTime(pack) {
	const second = bcd$1(pack[2] & 127);
	const minute = bcd$1(pack[3] & 127);
	const hour = bcd$1(pack[4] & 63);
	if (hour > 23 || minute > 59 || second > 59) return null;
	return {
		hour,
		minute,
		second
	};
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
function extractTimestamp(data) {
	if (data.length < 4 || data[0] !== 31 || data[1] !== 7 || data[2] !== 0) return null;
	let date = null;
	let time = null;
	const sequences = Math.max(1, Math.floor(data.length / DIF_SEQUENCE_SIZE));
	for (let s = 0; s < sequences; s++) {
		const seqStart = s * DIF_SEQUENCE_SIZE;
		for (let blockIdx = 3; blockIdx <= 5; blockIdx++) {
			const blockStart = seqStart + blockIdx * 80;
			if (blockStart + 80 > data.length) break;
			for (let i = blockStart + 3; i + 5 <= blockStart + 80; i += 5) {
				const header = data[i];
				if (!date && header === PACK_VAUX_REC_DATE) date = parseRecDate(data.subarray(i, i + 5));
				else if (!time && header === PACK_VAUX_REC_TIME) time = parseRecTime(data.subarray(i, i + 5));
				if (date && time) return _objectSpread2(_objectSpread2({}, date), time);
			}
		}
	}
	return date && time ? _objectSpread2(_objectSpread2({}, date), time) : null;
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
function extractHdvTimestamp(userData) {
	let date = null;
	let time = null;
	for (let i = 0; i + 5 <= userData.length; i++) {
		const h = userData[i];
		if (!date && h === PACK_VAUX_REC_DATE) {
			const d = parseRecDate(userData.subarray(i, i + 5));
			if (d) date = d;
		} else if (!time && h === PACK_VAUX_REC_TIME) {
			const t = parseRecTime(userData.subarray(i, i + 5));
			if (t) time = t;
		}
		if (date && time) break;
	}
	return date && time ? _objectSpread2(_objectSpread2({}, date), time) : null;
}

//#endregion
//#region src/io.ts
function read4cc(buf, offset) {
	return String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
}
function readU16LE(buf, offset) {
	return buf[offset] | buf[offset + 1] << 8;
}
function readU32LE(buf, offset) {
	return (buf[offset] | buf[offset + 1] << 8 | buf[offset + 2] << 16 | buf[offset + 3] << 24) >>> 0;
}
function readU64LE(buf, offset) {
	const lo = readU32LE(buf, offset);
	return readU32LE(buf, offset + 4) * 4294967296 + lo;
}
function readU32BE(buf, offset) {
	return (buf[offset] << 24 | buf[offset + 1] << 16 | buf[offset + 2] << 8 | buf[offset + 3]) >>> 0;
}
function readU64BE(buf, offset) {
	const hi = readU32BE(buf, offset);
	const lo = readU32BE(buf, offset + 4);
	return hi * 4294967296 + lo;
}
function fileSize(handle) {
	handle.seekToEnd();
	return handle.offset();
}

//#endregion
//#region src/sources/avi.ts
function openAvi(handle) {
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
	if (read4cc(head, 0) !== "RIFF" || read4cc(head, 8) !== "AVI ") {
		handle.close();
		return null;
	}
	let segments = [];
	const superIdx = findVideoSuperIndex(handle, fileLen);
	if (superIdx && superIdx.length > 0) for (const e of superIdx) {
		handle.seekTo(e.offset);
		const buf = handle.read(8 + e.size);
		if (!buf || buf.length < 8 + e.size) continue;
		if (!read4cc(buf, 0).startsWith("ix")) continue;
		const offsets = parseStandardIndex(buf.subarray(8));
		if (!offsets || offsets.length === 0) continue;
		segments.push({ offsets });
	}
	else segments = extrapolateFromRiffWalk(handle, fileLen);
	if (segments.length === 0) {
		handle.close();
		return null;
	}
	handle.seekTo(segments[0].offsets[0]);
	const dvHead = handle.read(4);
	if (!dvHead || dvHead.length < 4) {
		handle.close();
		return null;
	}
	const format = detectFormat(dvHead);
	if (!format) {
		handle.close();
		return null;
	}
	const cum = [0];
	for (const s of segments) cum.push(cum[cum.length - 1] + s.offsets.length);
	const total = cum[cum.length - 1];
	return {
		timestampAt(positionSec) {
			const frameIdx = Math.max(0, Math.floor(positionSec * format.fps));
			if (frameIdx >= total) return null;
			let segIdx = 0;
			while (segIdx + 1 < cum.length && cum[segIdx + 1] <= frameIdx) segIdx++;
			const seg = segments[segIdx];
			const local = frameIdx - cum[segIdx];
			handle.seekTo(seg.offsets[local]);
			const buf = handle.read(format.frameSize);
			return buf && buf.length > 0 ? extractTimestamp(buf) : null;
		},
		close() {
			try {
				handle.close();
			} catch (_unused) {}
		}
	};
}
/**
* Walk the first RIFF AVI's hdrl → strl chain looking for the indx super-
* index of the video stream. Returns the list of ix## chunk locations.
*/
function findVideoSuperIndex(handle, fileLen) {
	handle.seekTo(0);
	const rh = handle.read(12);
	if (!rh || rh.length < 12 || read4cc(rh, 0) !== "RIFF") return null;
	const riffSize = readU32LE(rh, 4);
	const hdrl = findListChild(handle, 12, Math.min(8 + riffSize, fileLen), "hdrl");
	if (!hdrl) return null;
	let pos = hdrl.dataStart;
	while (pos + 8 <= hdrl.dataEnd) {
		handle.seekTo(pos);
		const ch = handle.read(8);
		if (!ch || ch.length < 8) return null;
		const id = read4cc(ch, 0);
		const size = readU32LE(ch, 4);
		if (id === "LIST") {
			const lt = handle.read(4);
			if (!lt || lt.length < 4) return null;
			if (read4cc(lt, 0) === "strl") {
				const result = findIndxInStrl(handle, pos + 12, pos + 8 + size);
				if (result) return result;
			}
		}
		pos += 8 + size + (size & 1);
	}
	return null;
}
function findListChild(handle, start, end, listType) {
	let pos = start;
	while (pos + 8 <= end) {
		handle.seekTo(pos);
		const ch = handle.read(8);
		if (!ch || ch.length < 8) return null;
		const id = read4cc(ch, 0);
		const size = readU32LE(ch, 4);
		if (id === "LIST") {
			const lt = handle.read(4);
			if (!lt || lt.length < 4) return null;
			if (read4cc(lt, 0) === listType) return {
				dataStart: pos + 12,
				dataEnd: pos + 8 + size
			};
		}
		pos += 8 + size + (size & 1);
	}
	return null;
}
function findIndxInStrl(handle, start, end) {
	let isVideoStream = false;
	let indxAt = null;
	let pos = start;
	while (pos + 8 <= end) {
		handle.seekTo(pos);
		const ch = handle.read(8);
		if (!ch || ch.length < 8) return null;
		const id = read4cc(ch, 0);
		const size = readU32LE(ch, 4);
		if (id === "strh") {
			const data = handle.read(4);
			if (data && data.length >= 4) {
				const t = read4cc(data, 0);
				isVideoStream = t === "vids" || t === "iavs";
			}
		} else if (id === "indx") indxAt = {
			pos: pos + 8,
			size
		};
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
function parseSuperIndex(data) {
	if (data.length < 24) return null;
	const wLongsPerEntry = readU16LE(data, 0);
	const bIndexType = data[3];
	const nEntriesInUse = readU32LE(data, 4);
	if (bIndexType !== 0 || wLongsPerEntry !== 4) return null;
	const out = [];
	const max = Math.min(nEntriesInUse, Math.floor((data.length - 24) / 16));
	for (let i = 0; i < max; i++) {
		const p = 24 + i * 16;
		const offset = readU64LE(data, p);
		const size = readU32LE(data, p + 8);
		out.push({
			offset,
			size
		});
	}
	return out;
}
/**
* OpenDML standard chunk index (bIndexType=1): 24-byte header (last 8 bytes
* are qwBaseOffset) + N * 8-byte entries. Each entry's dwOffset is added to
* qwBaseOffset to get the absolute data offset of a chunk.
*/
function parseStandardIndex(data) {
	if (data.length < 24) return null;
	const wLongsPerEntry = readU16LE(data, 0);
	const bIndexType = data[3];
	const nEntriesInUse = readU32LE(data, 4);
	const chunkId = read4cc(data, 8);
	const baseOffset = readU64LE(data, 12);
	if (bIndexType !== 1 || wLongsPerEntry !== 2) return null;
	if (!isVideoChunk(chunkId)) return null;
	const out = [];
	const max = Math.min(nEntriesInUse, Math.floor((data.length - 24) / 8));
	for (let i = 0; i < max; i++) {
		const dwOffset = readU32LE(data, 24 + i * 8);
		out.push(baseOffset + dwOffset);
	}
	return out;
}
function extrapolateFromRiffWalk(handle, fileLen) {
	const segments = [];
	let pos = 0;
	while (pos + 12 <= fileLen) {
		handle.seekTo(pos);
		const rh = handle.read(12);
		if (!rh || rh.length < 12) break;
		if (read4cc(rh, 0) !== "RIFF") break;
		const riffSize = readU32LE(rh, 4);
		const riffType = read4cc(rh, 8);
		if (riffType !== "AVI " && riffType !== "AVIX") break;
		const riffEnd = Math.min(pos + 8 + riffSize, fileLen);
		const movi = findListChild(handle, pos + 12, riffEnd, "movi");
		if (movi) {
			const seg = extrapolateMovi(handle, movi.dataStart, movi.dataEnd);
			if (seg) segments.push(seg);
		}
		pos = riffEnd + (riffSize & 1);
	}
	return segments;
}
function extrapolateMovi(handle, start, end) {
	const first = findNextVideoChunk(handle, start, end);
	if (!first) return null;
	const second = findNextVideoChunk(handle, first.dataOffset + first.size + (first.size & 1), end);
	if (!second) return { offsets: [first.dataOffset] };
	const stride = second.dataOffset - first.dataOffset;
	if (stride <= 0) return null;
	const count = Math.max(1, 1 + Math.floor((end - first.dataOffset - first.size) / stride));
	const offsets = [];
	for (let i = 0; i < count; i++) offsets.push(first.dataOffset + i * stride);
	return { offsets };
}
function isVideoChunk(id) {
	return id.length === 4 && id[2] === "d" && (id[3] === "b" || id[3] === "c");
}
function findNextVideoChunk(handle, start, end) {
	let pos = start;
	for (let guard = 0; guard < 8 && pos + 8 <= end; guard++) {
		handle.seekTo(pos);
		const ch = handle.read(8);
		if (!ch || ch.length < 8) return null;
		const id = read4cc(ch, 0);
		const size = readU32LE(ch, 4);
		if (isVideoChunk(id)) return {
			dataOffset: pos + 8,
			size
		};
		pos += 8 + size + (size & 1);
	}
	return null;
}

//#endregion
//#region src/sources/m2t.ts
const SYNC_BYTE = 71;
const TS_PACKET_SIZE = 188;
const AUX_WINDOW = 1024 * 1024;
const VIDEO_WINDOW = 4 * 1024 * 1024;
const CACHE_THRESHOLD_SEC = .5;
function openM2t(handle) {
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
	if (pids.auxPid !== null) return makeAuxSource(handle, fileLen, framing, pids.auxPid);
	return makeVideoUserDataSource(handle, fileLen, framing, pids.videoPid);
}
function detectFraming(probe) {
	const maxStart = Math.min(256, probe.length - 384);
	for (let start = 0; start < maxStart; start++) {
		if (probe[start] !== SYNC_BYTE) continue;
		if (probe[start + 188] === SYNC_BYTE && probe[start + 376] === SYNC_BYTE) return {
			stride: 188,
			firstSync: start
		};
		if (probe[start + 192] === SYNC_BYTE && probe[start + 384] === SYNC_BYTE) return {
			stride: 192,
			firstSync: start
		};
	}
	return null;
}
/** Snap an arbitrary file offset down to the nearest packet boundary. */
function alignToPacket(approxOffset, framing) {
	if (approxOffset <= framing.firstSync) return framing.firstSync;
	const relative = approxOffset - framing.firstSync;
	return framing.firstSync + Math.floor(relative / framing.stride) * framing.stride;
}
function estimateWindowOffset(positionSec, durationSec, fileLen, framing, windowSize) {
	const est = Math.floor(positionSec / durationSec * fileLen);
	const maxStart = Math.max(framing.firstSync, fileLen - windowSize);
	return alignToPacket(Math.max(framing.firstSync, Math.min(est, maxStart)), framing);
}
function makeAuxSource(handle, fileLen, framing, auxPid) {
	let cachedPos = -1;
	let cachedTs = null;
	return {
		timestampAt(positionSec, durationSec) {
			if (!durationSec || durationSec <= 0) return cachedTs;
			if (cachedTs && Math.abs(positionSec - cachedPos) < CACHE_THRESHOLD_SEC) return cachedTs;
			const aligned = estimateWindowOffset(positionSec, durationSec, fileLen, framing, AUX_WINDOW);
			handle.seekTo(aligned);
			const win = handle.read(Math.min(AUX_WINDOW, fileLen - aligned));
			if (!win) return cachedTs;
			for (let pos = 0; pos + TS_PACKET_SIZE <= win.length; pos += framing.stride) {
				if (win[pos] !== SYNC_BYTE) continue;
				const b1 = win[pos + 1];
				if (((b1 & 31) << 8 | win[pos + 2]) !== auxPid) continue;
				if ((b1 >> 6 & 1) === 0) continue;
				const payloadStart = tsPayloadStart(win, pos);
				if (payloadStart === null) continue;
				const ts = decodeAuxPes(win.subarray(payloadStart, pos + TS_PACKET_SIZE));
				if (ts) {
					cachedPos = positionSec;
					cachedTs = ts;
					return ts;
				}
			}
			return cachedTs;
		},
		close() {
			try {
				handle.close();
			} catch (_unused) {}
		}
	};
}
function decodeAuxPes(payload) {
	if (payload.length < 8 || payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1 || payload[3] !== 191) return null;
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
function scanForHdvAuxPacks(body) {
	for (let i = 0; i + 14 <= body.length; i++) {
		if (body[i] !== 99) continue;
		if (body[i + 5] !== 192) continue;
		if (body[i + 10] !== 255) continue;
		const date = parseSonyHdvRecDate(body, i + 5);
		if (!date) continue;
		const tc = parseSonyHdvTimecode(body, i);
		const second = bcd(body[i + 11] & 127);
		const minute = bcd(body[i + 12] & 127);
		const hour = bcd(body[i + 13] & 63);
		const clock = second > 59 || minute > 59 || hour > 23 ? null : {
			hour,
			minute,
			second
		};
		if (!clock && !tc) return date;
		return _objectSpread2(_objectSpread2(_objectSpread2({}, date), clock), tc);
	}
	return null;
}
function parseSonyHdvTimecode(body, i) {
	const tcHour = bcd(body[i + 1] & 63);
	const tcFrame = bcd(body[i + 2] & 63);
	const tcSecond = bcd(body[i + 3] & 127);
	const tcMinute = bcd(body[i + 4] & 127);
	if (tcHour > 23 || tcMinute > 59 || tcSecond > 59 || tcFrame > 29) return null;
	return {
		tcHour,
		tcMinute,
		tcSecond,
		tcFrame
	};
}
function bcd(b) {
	return (b & 15) + (b >>> 4 & 15) * 10;
}
function parseSonyHdvRecDate(body, i) {
	const day = bcd(body[i + 2] & 63);
	const month = bcd(body[i + 3] & 31);
	const yearBcd = bcd(body[i + 4]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	return {
		year: yearBcd >= 75 ? 1900 + yearBcd : 2e3 + yearBcd,
		month,
		day
	};
}
function makeVideoUserDataSource(handle, fileLen, framing, videoPid) {
	let cachedPos = -1;
	let cachedTs = null;
	return {
		timestampAt(positionSec, durationSec) {
			if (!durationSec || durationSec <= 0) return cachedTs;
			if (cachedTs && Math.abs(positionSec - cachedPos) < CACHE_THRESHOLD_SEC) return cachedTs;
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
			return ts !== null && ts !== void 0 ? ts : cachedTs;
		},
		close() {
			try {
				handle.close();
			} catch (_unused2) {}
		}
	};
}
function findStreamPids(handle, framing) {
	const SCAN_BYTES = 4 * 1024 * 1024;
	handle.seekTo(framing.firstSync);
	const buf = handle.read(SCAN_BYTES);
	if (!buf) return {
		auxPid: null,
		videoPid: null
	};
	let pmtPid = null;
	let auxPid = null;
	let videoPid = null;
	for (let pos = 0; pos + TS_PACKET_SIZE <= buf.length; pos += framing.stride) {
		if (buf[pos] !== SYNC_BYTE) continue;
		const b1 = buf[pos + 1];
		const pid = (b1 & 31) << 8 | buf[pos + 2];
		if ((b1 >> 6 & 1) === 0) continue;
		const payloadStart = tsPayloadStart(buf, pos);
		if (payloadStart === null) continue;
		if (pid === 0 && pmtPid === null) pmtPid = parsePat(buf, payloadStart, pos + TS_PACKET_SIZE);
		else if (pmtPid !== null && pid === pmtPid && auxPid === null && videoPid === null) {
			const found = parsePmt(buf, payloadStart, pos + TS_PACKET_SIZE);
			if (found) {
				auxPid = found.auxPid;
				videoPid = found.videoPid;
				if (auxPid !== null || videoPid !== null) break;
			}
		}
	}
	return {
		auxPid,
		videoPid
	};
}
function tsPayloadStart(buf, pos) {
	const adapt = buf[pos + 3] >> 4 & 3;
	if (adapt !== 1 && adapt !== 3) return null;
	let payloadStart = pos + 4;
	if (adapt === 3) {
		const adaptLen = buf[pos + 4];
		payloadStart = pos + 5 + adaptLen;
	}
	return payloadStart < pos + TS_PACKET_SIZE ? payloadStart : null;
}
function parsePat(buf, payloadStart, packetEnd) {
	const pointer = buf[payloadStart];
	const tableStart = payloadStart + 1 + pointer;
	if (tableStart + 8 > packetEnd) return null;
	if (buf[tableStart] !== 0) return null;
	const sectionLength = (buf[tableStart + 1] & 15) << 8 | buf[tableStart + 2];
	let p = tableStart + 8;
	const end = Math.min(tableStart + 3 + sectionLength - 4, packetEnd);
	while (p + 4 <= end) {
		const programNumber = buf[p] << 8 | buf[p + 1];
		const pid = (buf[p + 2] & 31) << 8 | buf[p + 3];
		if (programNumber !== 0) return pid;
		p += 4;
	}
	return null;
}
function parsePmt(buf, payloadStart, packetEnd) {
	var _auxA;
	const pointer = buf[payloadStart];
	const tableStart = payloadStart + 1 + pointer;
	if (tableStart + 12 > packetEnd) return null;
	if (buf[tableStart] !== 2) return null;
	const sectionLength = (buf[tableStart + 1] & 15) << 8 | buf[tableStart + 2];
	const programInfoLength = (buf[tableStart + 10] & 15) << 8 | buf[tableStart + 11];
	let p = tableStart + 12 + programInfoLength;
	const end = Math.min(tableStart + 3 + sectionLength - 4, packetEnd);
	let auxA1 = null;
	let auxA0 = null;
	let videoPid = null;
	while (p + 5 <= end) {
		const streamType = buf[p];
		const pid = (buf[p + 1] & 31) << 8 | buf[p + 2];
		const esInfoLength = (buf[p + 3] & 15) << 8 | buf[p + 4];
		if (auxA1 === null && streamType === 161) auxA1 = pid;
		if (auxA0 === null && streamType === 160) auxA0 = pid;
		if (videoPid === null && (streamType === 1 || streamType === 2)) videoPid = pid;
		p += 5 + esInfoLength;
	}
	return {
		auxPid: (_auxA = auxA1) !== null && _auxA !== void 0 ? _auxA : auxA0,
		videoPid
	};
}
function demuxVideoEs(tsData, framing, videoPid) {
	const out = new Uint8Array(tsData.length);
	let outLen = 0;
	for (let pos = 0; pos + TS_PACKET_SIZE <= tsData.length; pos += framing.stride) {
		if (tsData[pos] !== SYNC_BYTE) continue;
		const b1 = tsData[pos + 1];
		if (((b1 & 31) << 8 | tsData[pos + 2]) !== videoPid) continue;
		let payloadStart = tsPayloadStart(tsData, pos);
		if (payloadStart === null) continue;
		if ((b1 >> 6 & 1) === 1) {
			if (tsData[payloadStart] !== 0 || tsData[payloadStart + 1] !== 0 || tsData[payloadStart + 2] !== 1) continue;
			const pesHeaderLen = tsData[payloadStart + 8];
			payloadStart += 9 + pesHeaderLen;
			if (payloadStart >= pos + TS_PACKET_SIZE) continue;
		}
		const payloadEnd = pos + TS_PACKET_SIZE;
		out.set(tsData.subarray(payloadStart, payloadEnd), outLen);
		outLen += payloadEnd - payloadStart;
	}
	return out.subarray(0, outLen);
}
function findGopUserDataAndExtract(es) {
	let i = 0;
	while (i + 4 <= es.length) {
		if (es[i] !== 0 || es[i + 1] !== 0 || es[i + 2] !== 1 || es[i + 3] !== 184) {
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
			const code = es[k + 3];
			if (code === 178) {
				const dataStart = k + 4;
				let dataEnd = es.length;
				for (let m = dataStart; m + 3 <= es.length; m++) if (es[m] === 0 && es[m + 1] === 0 && es[m + 2] === 1) {
					dataEnd = m;
					break;
				}
				const ts = extractHdvTimestamp(es.subarray(dataStart, dataEnd));
				if (ts) return ts;
				break;
			} else if (code === 181) k += 4;
			else break;
		}
		i += 4;
	}
	return null;
}

//#endregion
//#region src/sources/mov.ts
const DV_CODECS = new Set([
	"dvc ",
	"dvcp",
	"dvpp",
	"dv5n",
	"dv5p"
]);
/**
* DV inside QuickTime (.mov / .qt). Walks atoms to find the video trak with
* a DV codec, then builds a sample-offset table from stco/co64 + stsc + stsz.
*/
function openMov(handle) {
	const moov = findAtom(handle, 0, fileSize(handle), "moov");
	if (!moov) {
		handle.close();
		return null;
	}
	const stbl = findDvVideoTrackStbl(handle, moov);
	if (!stbl) {
		handle.close();
		return null;
	}
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
	handle.seekTo(offsets[0]);
	const dvHead = handle.read(4);
	if (!dvHead) {
		handle.close();
		return null;
	}
	const format = detectFormat(dvHead);
	if (!format) {
		handle.close();
		return null;
	}
	return {
		timestampAt(positionSec) {
			const frameIdx = Math.max(0, Math.floor(positionSec * format.fps));
			if (frameIdx >= offsets.length) return null;
			handle.seekTo(offsets[frameIdx]);
			const buf = handle.read(format.frameSize);
			return buf && buf.length > 0 ? extractTimestamp(buf) : null;
		},
		close() {
			try {
				handle.close();
			} catch (_unused) {}
		}
	};
}
function readAtomHeader(handle, pos, parentEnd) {
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
	} else if (size === 0) size = parentEnd - pos;
	return {
		type,
		payloadStart,
		end: pos + size
	};
}
function findAtom(handle, start, end, type) {
	let pos = start;
	while (pos < end) {
		const a = readAtomHeader(handle, pos, end);
		if (!a || a.end <= pos) return null;
		if (a.type === type) return a;
		pos = a.end;
	}
	return null;
}
function findChild(handle, parent, type) {
	return findAtom(handle, parent.payloadStart, parent.end, type);
}
function findDvVideoTrackStbl(handle, moov) {
	let pos = moov.payloadStart;
	while (pos < moov.end) {
		const trak = readAtomHeader(handle, pos, moov.end);
		if (!trak || trak.end <= pos) return null;
		if (trak.type === "trak") {
			const mdia = findChild(handle, trak, "mdia");
			if (mdia) {
				const minf = findChild(handle, mdia, "minf");
				if (minf) {
					const stbl = findChild(handle, minf, "stbl");
					if (stbl) {
						const stsd = findChild(handle, stbl, "stsd");
						if (stsd && stsdHasDvCodec(handle, stsd)) return stbl;
					}
				}
			}
		}
		pos = trak.end;
	}
	return null;
}
function stsdHasDvCodec(handle, stsd) {
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
function readRange(handle, start, end) {
	const len = end - start;
	if (len <= 0 || len > 64 * 1024 * 1024) return null;
	handle.seekTo(start);
	const buf = handle.read(len);
	return buf && buf.length === len ? buf : null;
}
function buildSampleOffsets(stbl) {
	let stsc = null;
	let stsz = null;
	let chunkOffsets = null;
	let pos = 0;
	while (pos + 8 <= stbl.length) {
		const size = readU32BE(stbl, pos);
		const type = read4cc(stbl, pos + 4);
		if (size < 8 || pos + size > stbl.length) break;
		const payloadStart = pos + 8;
		const payloadEnd = pos + size;
		if (type === "stsc") stsc = parseStsc(stbl, payloadStart, payloadEnd);
		else if (type === "stsz") stsz = parseStsz(stbl, payloadStart, payloadEnd);
		else if (type === "stco") chunkOffsets = parseStco(stbl, payloadStart, payloadEnd);
		else if (type === "co64") chunkOffsets = parseCo64(stbl, payloadStart, payloadEnd);
		pos = payloadEnd;
	}
	if (!stsc || !stsz || !chunkOffsets) return null;
	return computeSampleOffsets(stsc, stsz, chunkOffsets);
}
function parseStsc(buf, start, end) {
	const count = readU32BE(buf, start + 4);
	const out = [];
	let p = start + 8;
	for (let i = 0; i < count && p + 12 <= end; i++) {
		out.push({
			firstChunk: readU32BE(buf, p),
			samplesPerChunk: readU32BE(buf, p + 4)
		});
		p += 12;
	}
	return out;
}
function parseStsz(buf, start, end) {
	const defaultSize = readU32BE(buf, start + 4);
	const count = readU32BE(buf, start + 8);
	if (defaultSize > 0) return {
		defaultSize,
		sizes: null
	};
	const sizes = new Uint32Array(count);
	let p = start + 12;
	for (let i = 0; i < count && p + 4 <= end; i++) {
		sizes[i] = readU32BE(buf, p);
		p += 4;
	}
	return {
		defaultSize: 0,
		sizes
	};
}
function parseStco(buf, start, end) {
	const count = readU32BE(buf, start + 4);
	const out = [];
	let p = start + 8;
	for (let i = 0; i < count && p + 4 <= end; i++) {
		out.push(readU32BE(buf, p));
		p += 4;
	}
	return out;
}
function parseCo64(buf, start, end) {
	const count = readU32BE(buf, start + 4);
	const out = [];
	let p = start + 8;
	for (let i = 0; i < count && p + 8 <= end; i++) {
		out.push(readU64BE(buf, p));
		p += 8;
	}
	return out;
}
function computeSampleOffsets(stsc, stsz, chunkOffsets) {
	const result = [];
	let stscIdx = 0;
	let sampleIdx = 0;
	for (let chunkIdx = 0; chunkIdx < chunkOffsets.length; chunkIdx++) {
		var _stsc$stscIdx$samples, _stsc$stscIdx;
		while (stscIdx + 1 < stsc.length && stsc[stscIdx + 1].firstChunk - 1 <= chunkIdx) stscIdx++;
		const samplesPerChunk = (_stsc$stscIdx$samples = (_stsc$stscIdx = stsc[stscIdx]) === null || _stsc$stscIdx === void 0 ? void 0 : _stsc$stscIdx.samplesPerChunk) !== null && _stsc$stscIdx$samples !== void 0 ? _stsc$stscIdx$samples : 0;
		let offsetInChunk = 0;
		for (let s = 0; s < samplesPerChunk; s++) {
			var _stsz$sizes$sampleIdx, _stsz$sizes;
			result.push(chunkOffsets[chunkIdx] + offsetInChunk);
			const sampleSize = stsz.defaultSize > 0 ? stsz.defaultSize : (_stsz$sizes$sampleIdx = (_stsz$sizes = stsz.sizes) === null || _stsz$sizes === void 0 ? void 0 : _stsz$sizes[sampleIdx]) !== null && _stsz$sizes$sampleIdx !== void 0 ? _stsz$sizes$sampleIdx : 0;
			offsetInChunk += sampleSize;
			sampleIdx++;
		}
	}
	return result;
}

//#endregion
//#region src/sources/raw.ts
/** Raw DIF stream: the whole file is back-to-back frames of fixed size. */
function openRaw(handle) {
	handle.seekTo(0);
	const header = handle.read(4);
	if (!header || header.length < 4) {
		handle.close();
		return null;
	}
	const format = detectFormat(header);
	if (!format) {
		handle.close();
		return null;
	}
	const frameCount = Math.floor(fileSize(handle) / format.frameSize);
	return {
		timestampAt(positionSec) {
			const frameIdx = Math.max(0, Math.floor(positionSec * format.fps));
			if (frameIdx >= frameCount) return null;
			handle.seekTo(frameIdx * format.frameSize);
			const buf = handle.read(format.frameSize);
			return buf && buf.length > 0 ? extractTimestamp(buf) : null;
		},
		close() {
			try {
				handle.close();
			} catch (_unused) {}
		}
	};
}

//#endregion
//#region src/sources/index.ts
/**
* Open a file as a recording-timestamp source. The handle is consumed: on
* success the returned source owns it; on failure (unsupported container,
* not DV/HDV inside) the handle is closed and null is returned.
*/
function openSource(handle, ext) {
	switch (ext) {
		case "dv": return openRaw(handle);
		case "avi": return openAvi(handle);
		case "mov":
		case "qt": return openMov(handle);
		case "m2t":
		case "ts":
		case "mpg":
		case "mpeg":
		case "m2ts":
		case "mts": return openM2t(handle);
		default:
			try {
				handle.close();
			} catch (_unused) {}
			return null;
	}
}
function isSupportedExt(ext) {
	return ext === "dv" || ext === "avi" || ext === "mov" || ext === "qt" || ext === "m2t" || ext === "ts" || ext === "mpg" || ext === "mpeg" || ext === "m2ts" || ext === "mts";
}

//#endregion
//#region src/index.ts
const { core, event, file, overlay, console: log } = iina;
let opened = null;
let updateTimer = null;
let overlayInitialized = false;
let lastText = "";
const STYLE = `
  .ts {
    position: absolute;
    right: 24px;
    bottom: 24px;
    padding: 4px 8px;
    background: rgba(0, 0, 0, 0.50);
    backdrop-filter: blur(10px);
    color: #fff;
    text-align: right;
    font: 16px/1.2 ui-monospace, "SF Mono", Menlo, monospace;
    border-radius: 4px;
    pointer-events: none;
    user-select: none;
  }
`;
function fileExt(url) {
	const m = /\.([^./]+)$/.exec(url);
	return m ? m[1].toLowerCase() : "";
}
function urlToPath(url) {
	if (!url.startsWith("file://")) return url;
	const raw = url.substring(7);
	try {
		return decodeURIComponent(raw);
	} catch (_unused) {
		return raw;
	}
}
function pad2(n) {
	return n < 10 ? "0" + n : String(n);
}
function formatTimestamp(ts) {
	var _ts$minute, _ts$second, _ts$tcMinute, _ts$tcSecond, _ts$tcFrame;
	const date = `${ts.year}-${pad2(ts.month)}-${pad2(ts.day)}`;
	const clock = ts.hour === void 0 ? date : `${date} ${pad2(ts.hour)}:${pad2((_ts$minute = ts.minute) !== null && _ts$minute !== void 0 ? _ts$minute : 0)}:${pad2((_ts$second = ts.second) !== null && _ts$second !== void 0 ? _ts$second : 0)}`;
	if (ts.tcHour === void 0) return clock;
	return `${`TC ${pad2(ts.tcHour)}:${pad2((_ts$tcMinute = ts.tcMinute) !== null && _ts$tcMinute !== void 0 ? _ts$tcMinute : 0)}:${pad2((_ts$tcSecond = ts.tcSecond) !== null && _ts$tcSecond !== void 0 ? _ts$tcSecond : 0)}:${pad2((_ts$tcFrame = ts.tcFrame) !== null && _ts$tcFrame !== void 0 ? _ts$tcFrame : 0)}`}<br>${clock}`;
}
function ensureOverlayReady() {
	if (overlayInitialized) return true;
	if (!core.window.loaded) return false;
	overlay.simpleMode();
	overlay.setStyle(STYLE);
	overlay.setContent("");
	overlay.show();
	overlayInitialized = true;
	return true;
}
function showText(text) {
	if (text === lastText) return;
	lastText = text;
	if (!ensureOverlayReady()) return;
	overlay.setContent(text ? `<div class="ts">${text}</div>` : "");
}
function closeCurrent() {
	if (updateTimer !== null) {
		clearInterval(updateTimer);
		updateTimer = null;
	}
	if (opened) {
		opened.close();
		opened = null;
	}
	showText("");
}
function tick() {
	if (!opened) return;
	const position = core.status.position;
	if (position === null) return;
	const duration = core.status.duration;
	const ts = opened.timestampAt(position, duration !== null && duration !== void 0 ? duration : void 0);
	showText(ts ? formatTimestamp(ts) : "");
}
function openFile(url) {
	closeCurrent();
	const ext = fileExt(url);
	if (!isSupportedExt(ext)) return;
	const path = urlToPath(url);
	log.log(`DV Timecode: opening .${ext}: ${path}`);
	let handle;
	try {
		handle = file.handle(path, "read");
	} catch (e) {
		log.error(`DV Timecode: cannot open file: ${e}`);
		return;
	}
	const source = openSource(handle, ext);
	if (!source) {
		log.log(`DV Timecode: .${ext} file does not contain DV/HDV`);
		return;
	}
	opened = source;
	updateTimer = setInterval(tick, 200);
}
event.on("iina.file-loaded", (url) => {
	openFile(url);
});
event.on("iina.window-will-close", () => {
	closeCurrent();
});

//#endregion