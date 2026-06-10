import { DvTimestamp } from './dv';
import { Source, isSupportedExt, openSource } from './sources';

const { core, event, file, overlay, console: log } = iina;

let opened: Source | null = null;
let updateTimer: string | null = null;
let overlayInitialized = false;
let lastText = '';
// Which fields the current file has ever provided. Lets a mid-stream dropout
// mask exactly what was lost: a file that never had a tape TC won't sprout a
// dashed TC line, while a full dropout dashes every line the file normally
// shows. Reset per file in closeCurrent().
let seenTc = false;
let seenWall = false;
let seenDate = false;

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

// Masked date standing in for `YYYY.MM.DD`. The `.` separators (not `-`) keep
// it legible as a date even when every digit is a dash.
const DASH_DATE = '----.--.--';

// The tape-TC line: real value when present; a dashed placeholder once the file
// has shown a TC but the current position has none; otherwise omitted.
function tcLine(ts: DvTimestamp | null): string | null {
  if (ts && ts.tcHour !== undefined) {
    return `TC ${pad2(ts.tcHour)}:${pad2(ts.tcMinute ?? 0)}:${pad2(ts.tcSecond ?? 0)}:${pad2(ts.tcFrame ?? 0)}`;
  }
  return seenTc ? 'TC --:--:--:--' : null;
}

// The date + wall-clock line. With data we show what we have (date always, time
// when present); on a dropout we dash the parts the file normally shows.
function dateTimeLine(ts: DvTimestamp | null): string | null {
  if (ts) {
    const date = `${ts.year}.${pad2(ts.month)}.${pad2(ts.day)}`;
    if (ts.hour !== undefined) {
      return `${date} ${pad2(ts.hour)}:${pad2(ts.minute ?? 0)}:${pad2(ts.second ?? 0)}`;
    }
    return seenWall ? `${date} --:--:--` : date;
  }
  if (!seenDate) return null;
  return seenWall ? `${DASH_DATE} --:--:--` : DASH_DATE;
}

// Build the overlay HTML. `ts` is null when the current position has no data;
// the seen* flags then choose between a "data lost" placeholder and nothing.
// The tape TC sits on its own line above the date/wall-clock; the .ts box is
// right-aligned so both lines hug the right edge.
function render(ts: DvTimestamp | null): string {
  if (ts) {
    seenDate = true;
    if (ts.hour !== undefined) seenWall = true;
    if (ts.tcHour !== undefined) seenTc = true;
  }
  const lines: string[] = [];
  const tc = tcLine(ts);
  if (tc !== null) lines.push(tc);
  const dt = dateTimeLine(ts);
  if (dt !== null) lines.push(dt);
  return lines.join('<br>');
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
  seenTc = seenWall = seenDate = false;
  showText('');
}

function tick() {
  if (!opened) return;
  const position = core.status.position;
  if (position === null) return;
  const duration = core.status.duration;
  const ts = opened.timestampAt(position, duration ?? undefined);
  showText(render(ts));
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
  // Poll on a timer; mpv.time-pos.changed fires too often. HDV asks for a
  // frame-cadence interval so its interpolated tape TC advances smoothly;
  // other sources take the default.
  updateTimer = setInterval(tick, source.updateIntervalMs ?? 200);
}

event.on('iina.file-loaded', (url: string) => {
  openFile(url);
});

event.on('iina.window-will-close', () => {
  closeCurrent();
});
