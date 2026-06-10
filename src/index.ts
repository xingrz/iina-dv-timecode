import { DvTimestamp } from './dv';
import { Source, isSupportedExt, openSource } from './sources';

const { core, event, file, overlay, console: log } = iina;

let opened: Source | null = null;
let updateTimer: string | null = null;
let overlayInitialized = false;
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
    text-align: right;
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
  const date = `${ts.year}-${pad2(ts.month)}-${pad2(ts.day)}`;
  const clock =
    ts.hour === undefined
      ? date
      : `${date} ${pad2(ts.hour)}:${pad2(ts.minute ?? 0)}:${pad2(ts.second ?? 0)}`;
  if (ts.tcHour === undefined) return clock;
  // Frame-accurate tape timecode on its own line above the wall-clock; the
  // .ts box is right-aligned so both lines hug the right edge.
  const tc = `TC ${pad2(ts.tcHour)}:${pad2(ts.tcMinute ?? 0)}:${pad2(ts.tcSecond ?? 0)}:${pad2(ts.tcFrame ?? 0)}`;
  return `${tc}<br>${clock}`;
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
    opened.close();
    opened = null;
  }
  showText('');
}

function tick() {
  if (!opened) return;
  const position = core.status.position;
  if (position === null) return;
  const duration = core.status.duration;
  const ts = opened.timestampAt(position, duration ?? undefined);
  showText(ts ? formatTimestamp(ts) : '');
}

function openFile(url: string) {
  closeCurrent();

  const ext = fileExt(url);
  if (!isSupportedExt(ext)) return;

  const path = urlToPath(url);
  log.log(`DV Timecode: opening .${ext}: ${path}`);

  let handle: IINA.API.FileHandle;
  try {
    handle = file.handle(path, 'read');
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
  // Poll on a timer; mpv.time-pos.changed fires too often.
  updateTimer = setInterval(tick, 200);
}

event.on('iina.file-loaded', (url: string) => {
  openFile(url);
});

event.on('iina.window-will-close', () => {
  closeCurrent();
});
