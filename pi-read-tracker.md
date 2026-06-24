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
- Widget rows render as `filename` when the tracked file sits directly in the session `cwd`. If the file lives in a nested subdirectory (e.g., `./subpath/...`) a relative subpath like `./subpath` is shown after the `|`, and external files still show their absolute parent path (the gutter stays ⚠️ for those). Counts remain `📖nnn` (three-character, right-aligned) so the numbers stay aligned.
- Entries are sorted by the most recent read time so the widget keeps the freshest files at the top, and the separator (` | `) now matches the `theme.fg("dim", …)` treatment used by the npm `pi-file-tracker` widget so they share a consistent divider style.

## Design notes

- The internal list is always built from resolved canonical absolute paths (`resolveFileCandidate`) so every entry maps to a unique filesystem location before it is counted or persisted.
- Validation only accepts file paths whose basename matches the approved regex, and duplicates accumulate by incrementing the read count instead of re-adding nodes to the map.
- Formatting follows `gutter | filename`, and when the file lives below the cwd the relative subpath (e.g., `./wip`) is appended after the separator. External files continue to show their absolute parent directory, rendered in the `dim` tone to keep third-party paths in the background. Verified files render their basename in the accent palette while guesses stay muted, and parent paths use `text` when confirmed or `border` when still uncertain, keeping the UI readable across themes. Each entry also records when it was last read so the sorted order reflects recency.
- The read count prints as `📖nnn` (three characters, spaces as needed) so the numbers stay right-aligned regardless of magnitude.
