# @your-org/pi-read-tracker

A companion to pi-file-tracker that infers which files have been **read** during a session (via explicit `read` tool calls and common shell commands).

## Install (development)

Copy `index.ts` into your extensions directory:

```bash
cp external/pi-read-tracker/index.ts ~/.pi/agent/extensions/read-tracker/index.ts
```

## Commands

| Command             | Effect                                    |
|---------------------|-------------------------------------------|
| `/read-tracker`     | Toggle the read-files widget on/off       |
| `/read-tracker clear` | Clear the tracked read-files list         |

## Behavior

- Tracks `read` tool calls (`read(path)`) and infers reads from common shell utilities (`cat`, `grep`, `less`, etc.).
- Uses a composed helper that normalizes separators, resolves an absolute path consistently on macOS/Windows, validates the filename portion (currently `/^[A-Za-z0-9._-]+$/`), and only lets canonical absolute paths enter the internal map—anything that fails that check is dropped even if it looked like a file spec (e.g., `@pi-read-tracker.md`).
- When the session is restored, each persisted path is re-run through the same validator so legacy invalid entries gracefully disappear rather than showing bad filenames.
- Persists state in the session so it survives restarts and branch navigation.
- The helper records whether the path existed when first tracked, and each render re-checks `fs.existsSync` so confirmed files use the accent/dim palette while missing guesses stay muted until they materialize.
- Widget rows render as `filename | parent-path`, where the `parent-path` is the file’s directory expressed as an absolute path. External directories keep that absolute form (with the ⚠️ gutter), and counts stay `📖nnn` (three-character, right-aligned).
