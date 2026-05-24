import {
  detectFormat,
  extractTimestampFromSequence,
  DIF_SEQUENCE_SIZE,
  DvFormat,
  DvTimestamp,
} from './dv';

const { core, event, file, overlay, console: log } = iina;

log.log('DV Timecode: entry loaded');

interface OpenedFile {
  handle: IINA.API.FileHandle;
  format: DvFormat;
}

let opened: OpenedFile | null = null;
let updateTimer: string | null = null;
let overlayInitialized = false;
let lastFrameRead = -1;
let lastText = '';

const STYLE = `
  .ts {
    position: absolute;
    right: 24px;
    bottom: 24px;
    padding: 4px 8px;
    background: rgba(0, 0, 0, 0.50);
    backdrop-filter: blur(10px);
    color: #fff;
    font: 16px/1.2 ui-monospace, "SF Mono", Menlo, monospace;
    border-radius: 4px;
    pointer-events: none;
    user-select: none;
  }
`;

function fileExt(url: string): string {
  const m = /\.([^./]+)$/.exec(url);
  return m ? m[1]!.toLowerCase() : '';
}

function urlToPath(url: string): string {
  if (!url.startsWith('file://')) return url;
  const raw = url.substring('file://'.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function formatTimestamp(ts: DvTimestamp): string {
  return `${ts.year}-${pad2(ts.month)}-${pad2(ts.day)} ${pad2(ts.hour)}:${pad2(ts.minute)}:${pad2(ts.second)}`;
}

function ensureOverlayReady(): boolean {
  if (overlayInitialized) return true;
  // simpleMode/setStyle/show silently no-op (or throw) before the window exists.
  if (!core.window.loaded) return false;
  overlay.simpleMode();
  overlay.setStyle(STYLE);
  overlay.setContent('');
  overlay.show();
  overlayInitialized = true;
  return true;
}

function showText(text: string) {
  if (text === lastText) return;
  lastText = text;
  if (!ensureOverlayReady()) return;
  overlay.setContent(text ? `<div class="ts">${text}</div>` : '');
}

function closeCurrent() {
  if (updateTimer !== null) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  if (opened) {
    try { opened.handle.close(); } catch { /* ignore */ }
    opened = null;
  }
  lastFrameRead = -1;
  showText('');
}

function tick() {
  if (!opened) return;
  const position = core.status.position;
  if (position === null) return;

  const { handle, format } = opened;
  const frameIdx = Math.max(0, Math.floor(position * format.fps));
  if (frameIdx === lastFrameRead) return;
  lastFrameRead = frameIdx;

  const offset = frameIdx * format.frameSize;
  try {
    handle.seekTo(offset);
  } catch (e) {
    log.warn(`DV Timecode: seek to ${offset} failed: ${e}`);
    return;
  }

  // Only the first DIF sequence is needed; VAUX rec-date/time is duplicated
  // across sequences within the same frame.
  const seq = handle.read(DIF_SEQUENCE_SIZE);
  if (!seq || seq.length < DIF_SEQUENCE_SIZE) return;

  const ts = extractTimestampFromSequence(seq);
  showText(ts ? formatTimestamp(ts) : '');
}

function openFile(url: string) {
  closeCurrent();

  if (fileExt(url) !== 'dv') {
    log.log(`DV Timecode: ${url} is not .dv, skipping`);
    return;
  }

  const path = urlToPath(url);
  log.log(`DV Timecode: opening ${path}`);

  let handle: IINA.API.FileHandle;
  try {
    handle = file.handle(path, 'read');
  } catch (e) {
    log.error(`DV Timecode: cannot open file: ${e}`);
    return;
  }

  const header = handle.read(4);
  if (!header || header.length < 4) {
    log.error('DV Timecode: file too small to be DV');
    handle.close();
    return;
  }

  const format = detectFormat(header);
  if (!format) {
    log.error('DV Timecode: file does not look like raw DV (header SCT/DSF mismatch)');
    handle.close();
    return;
  }
  log.log(`DV Timecode: detected ${format.system.toUpperCase()}, ${format.fps.toFixed(3)} fps, frame=${format.frameSize}B`);

  opened = { handle, format };
  // Drive updates on a timer rather than every mpv.time-pos.changed: tick() is
  // cheap (one seek + 12 KB read), but the property fires many times/second.
  updateTimer = setInterval(tick, 200);
}

event.on('iina.file-loaded', (url: string) => {
  openFile(url);
});

event.on('iina.window-will-close', () => {
  closeCurrent();
});
