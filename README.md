# IINA DV Timecode

An [IINA](https://iina.io) plugin that overlays the original recording date
and time — read from camera metadata embedded in the file — on top of DV /
HDV tape captures.

![Screenshot of IINA playing a DV file with the recording timestamp overlaid in the bottom-right corner](docs/screenshot.png)

## Supported formats

| Container | Extensions | Codec |
| --- | --- | --- |
| Raw DV (bare DIF bitstream) | `.dv` | DV |
| AVI (Type 1 / Type 2 / OpenDML AVI 2.0) | `.avi` | DV |
| QuickTime | `.mov`, `.qt` | DV |
| MPEG-TS (auto-detects 188- and 192-byte framing) | `.m2t`, `.ts`, `.mpg`, `.mpeg`, `.m2ts`, `.mts` | HDV (MPEG-2) |

The wall-clock recording time is decoded from the DV VAUX `0x62` / `0x63`
packs (DV containers) or Sony HDV's vendor-specific `0xC0` pack and the
adjacent reversed-byte `SS MM HH` field (HDV streams).

## Installation

In IINA, open **Preferences → Plugin → Install from GitHub…**, paste:

```
xingrz/iina-dv-timecode
```

IINA will download the latest release from GitHub and prompt you for the
required permissions (`Video Overlay`, `Access File System`). It also
auto-updates whenever the `ghVersion` field in `Info.json` bumps.

To install a development checkout instead, symlink the repo:

```sh
ln -s "$(pwd)" \
  ~/Library/Application\ Support/com.colliderli.iina/plugins/dv-timecode.iinaplugin-dev
```

## How it works

When you open a supported file the plugin parses just enough of the
container to locate the camera metadata pack for the current playback
frame, then displays the decoded timestamp in the bottom-right corner of
the player window. Reads are bounded to a small window per tick (typically
a single 12 KB DIF sequence or a 1 MB TS window), so multi-GB tape dumps
open instantly.

For HDV files the timestamp granularity is per-GOP (~0.5 s) and is read
on demand from the AUX private stream. For DV-in-AVI we parse the OpenDML
`indx` / `ix##` super-index to seek directly to any frame's bytes without
walking the file.

## Development

```sh
npm install   # also configures the pre-commit hook (.githooks/)
npm run build # bundle src/ into dist/index.js via tsdown
npm run check # type-check via tsc
npm run watch # rebuild on source change (re-launch IINA to pick up changes)
```

The plugin entry is the bundled `dist/index.js`, committed to the repo so
end users installing from GitHub don't need a build toolchain. The
pre-commit hook re-runs `npm run build` and stages the result on every
commit, so `dist/` is always in sync with the source you're committing.

### Releasing a new version

1. Bump `version` in `Info.json` and `package.json`.
2. Bump `ghVersion` (an integer) in `Info.json` — IINA compares this
   against the latest GitHub release to decide if an update is available.
3. Commit, tag `vX.Y.Z`, push.

## License

MIT — see [LICENSE](LICENSE).
