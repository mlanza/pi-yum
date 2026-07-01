# @your-org/pi-read-tracker

A companion to pi-file-tracker that infers which files have been **read** during a session (via explicit `read` tool calls and common shell commands).

## Install (development)

The extension imports `whatsop/core.js` for path normalisation and invocation
parsing. Both the extension source and the `whatsop/` directory must be
accessible from the workspace root (dynamic import resolves via `cwd`).

Copy `index.ts` into your extensions directory:

```bash
cp external/pi-read-tracker/index.ts ~/.pi/agent/extensions/read-tracker/index.ts
```

If `whatsop/core.js` is unavailable at runtime, the extension falls back to
its built-in path resolution logic.

## CLI Flag

| Flag | Effect |
|------|--------|
| `--read-tracker-log` | Enable JSONL invocation logging to `<session-id>.jsonl` in the workspace root |

When active, every raw invocation (bash + all tool calls) is logged losslessly.
Omit the flag (default) for zero logging overhead.

## Commands

| Command             | Effect                                    |
|---------------------|-------------------------------------------|
| `/read-tracker`     | Toggle the read-files widget on/off       |
| `/read-tracker clear` | Clear the tracked read-files list         |
| `/read-tracker all` | Toggle show-all mode to reveal every tracked file |
| `/read-tracker limit <N>` | Set the visible-file limit (default: `8`) and exit show-all mode |

## Behavior

- Tracks `read` tool calls (`read(path)`) and infers reads from common shell utilities (`cat`, `grep`, `less`, etc.).
- Uses a composed helper that normalizes separators, resolves an absolute path consistently on macOS/Windows, validates the filename portion (using regex `/^(?!\d+$)[A-Za-z0-9._-]+$/` to exclude purely numeric basenames), and only lets canonical absolute paths enter the internal map—anything that fails that check is dropped even if it looked like a file spec (e.g., `@pi-read-tracker.md`).
- When the session is restored, each persisted path is re-run through the same validator so legacy invalid entries gracefully disappear rather than showing bad filenames.
- Persists state in the session so it survives restarts and branch navigation.
- The helper records whether the path existed when first tracked, and each render re-checks `fs.existsSync` so confirmed files use the accent/dim palette while missing guesses stay muted until they materialize.
- Widget rows render as `filename  |  /absolute/parent` matching the Edited files pane style. When the file sits directly in the session `cwd` the parent path is omitted entirely. Subdirectory and external files both show the absolute parent path (external ones get a ⚠️ gutter). Counts remain `📖nnn` (three-character, right-aligned) so the numbers stay aligned.
- Entries are sorted by the most recent read time so the widget keeps the freshest files at the top, and the separator (` | `) now matches the `theme.fg("dim", …)` treatment used by the npm `pi-file-tracker` widget so they share a consistent divider style.
- Commands that only sniff the tree (for example `rg -n …`) are treated as questionable reads: the entry still counts, but the left gutter switches to a ❓ and the internal flag remembers the inference came from a heuristic scan.
- The widget only renders the most recent `8` reads by default. When older entries are hidden the header switches to `Read files (visible/total)` and a dim footer highlights `… N older files hidden · /read-tracker all`.
- Use `/read-tracker all` to toggle showing every tracked file, and `/read-tracker limit <N>` to raise the visible-file cap and exit show-all mode.

## Design notes

- The internal list is always built from resolved canonical absolute paths (`resolveFileCandidate`) so every entry maps to a unique filesystem location before it is counted or persisted.
- Validation only accepts file paths whose basename matches the approved regex, and duplicates accumulate by incrementing the read count instead of re-adding nodes to the map.
- Formatting follows `gutter | filename`, and when the file lives below the cwd the relative subpath (e.g., `wip`) is appended after the separator. External files continue to show their absolute parent directory, rendered in the `dim` tone to keep third-party paths in the background. Verified files render their basename in the accent palette while guesses stay muted, and parent paths use `text` when confirmed or `border` when still uncertain, keeping the UI readable across themes. Each entry also records when it was last read so the sorted order reflects recency.
- The read count prints as `📖nnn` (three characters, spaces as needed) so the numbers stay right-aligned regardless of magnitude.
- The gutter can show a ❓ to highlight questionable reads, and the persisted state captures a `questionable` flag so every session retains the trust level for each inference.

## Companion: Normalization Library (whatsop/core.js & cli.js)

### Overview

A standalone ES module that parses raw CLI invocations (from bash or adapted tool calls) into a normalized intermediate representation of one or more subcommands, actors, and resources. The core module lives at `whatsop/core.js`; a companion `whatsop/cli.js` provides a command-line harness for testing and eyeballing results.

#### Output shape

- **fullCommand**: the complete original invocation string
- **origin**: marker for the invocation source (e.g. `bash`, `tool-call`)
- **subcommands**: an array of parsed nodes, each with:
  - **actor**: the primary executable (first token) resolved to an absolute path
  - **args**: an array of argument objects in the order they appeared, each with:
    - **arg**: the raw argument text
    - **type**: one of `arg`, `resource`, `actor`, or `data`
    - **absolutePath**: for `resource` or `actor` types, the resolved filesystem path (or `null` if unresolvable)
    - **questionable**: `0` (confident) or `1` (uncertain); only present for `resource` and `actor` types. A value of `0` means the `absolutePath` was confirmed via filesystem existence or reliable resolution. `1` means resolution was attempted but could not be confirmed.
    - **data** (only for `data` type): the raw structured value (object/array)
    - **expanded** (only for `data` type): if a `dataCallback` was provided, the array of nodes returned by the callback

Subcommands may include secondary actors (e.g. a runtime like `node` plus the script file) and zero or more resources (files or URLs).

### `data` type and expansion callback

Structured data objects (JSON payloads from tool calls) are classified as type `data`. They embed resources, actors, and arguments in a non-trivial structure that cannot be reliably parsed by path heuristics alone. The library accepts an optional `dataCallback` for expanding such items:

```js
async function dataCallback(raw, meta) {
  // raw        – the structured data value (object, array, etc.)
  // meta.actor       – e.g. "read", "edit"
  // meta.origin      – e.g. "tool-call"
  // meta.fullCommand – the full invocation string
  // Returns an array of ArgNode objects
}
```

When provided, every `data`-typed arg is passed through this callback. The returned nodes are stored in the `expanded` array of that arg. This lets the consumer (e.g. the pi-read-tracker extension) supply domain-specific knowledge about how to extract file paths from known tool shapes.

### Collective context (`fileMemo`)

File classification is not done in isolation — the library builds confidence across
invocations by maintaining a **file memo**: a `Set` of absolute paths that have been
confirmed as files during the session. Each call to `normalize` can both read from
and contribute to this memo.

```js
// Caller maintains the memo across invocations
const fileMemo = new Set();

await normalize(invA, { cwd, fileMemo });  // confirms paths → adds to memo
await normalize(invB, { cwd, fileMemo });  // consults memo during scoring
```

#### How the memo adds weight

When classifying a token, the library considers multiple factors to calculate
the likelihood that a token refers to a file:

| Factor | Weight | Notes |
|--------|--------|-------|
| `fs.existsSync(path)` | Very high | The file exists on disk **right now** |
| Path is in `fileMemo` | High | Previously confirmed as a file in this session |
| Resolves via `which`/`where` | High | Confirms it's an executable (actor) |
| Has a file extension (`.ts`, `.md`, etc.) | Medium | Plausible file reference |
| Is a dotfile (starts with `.`) | Medium | Intentional file reference, not a search pattern |
| Contains path separators | Low | Looks like a path, not a bare word |
| Starts with `./`, `../`, `~`, `/`, or `X:\` | Low–Medium | Explicit path prefix |
| URL parse succeeds | Medium | Remote resource |
| Starts with `-` or contains `=` | Zero (negative) | Almost certainly a flag or option |

A token whose resolved path appears in the `fileMemo` gets a confidence boost
similar to finding the file on disk. This lets the library recognise a path as
a file even when the file has been renamed or deleted since it was first
encountered — the collective context says "we've seen this as a file before".

#### Memo lifecycle

The caller (e.g. the pi-read-tracker extension) owns the memo and is responsible
for:

1. **Seeding**: passing in paths that are already known to be files (e.g., from
   session restore or from explicit `read` tool calls that the extension handles
   directly).
2. **Feeding**: after each `normalize` call, collecting any newly-confirmed
   absolute paths from the result and adding them to the memo. Paths where
   `questionable === 0` are strong candidates; paths with `questionable === 1`
   may be added with lower confidence for future reference.
3. **Persistence**: saving the memo across session boundaries (e.g., as part of
   the persisted tracker state) so that collective context survives restarts.

#### Scoring sketch

Internally the library can assign a confidence score to each token and classify
based on thresholds:

```
score ≥ 0.9  →  type: "resource", questionable: 0   (confident file)
score ≥ 0.5  →  type: "resource", questionable: 1   (plausible file)
score < 0.5  →  type: "arg"                          (not a file)
```

The optional `fileMemo` shifts the score upward for paths that have been
previously confirmed, making them more likely to be classified as files even
when other signals are weak.

### Path compression for display (`compressPath`)

`compressPath` is a standalone export that compresses a long absolute directory
path by elliding middle segments with `"..."`, preserving the root and the last
directory. It is used by the read-tracker widget to fit external file paths into
the available line width.

```js
import { compressPath } from "./whatsop/core.js";

compressPath("C:\\Users\\mlanza\\Projects\\pi-yum\\whatsop", 35);
// → "C:\Users\mlanza\...\pi-yum\whatsop"
```

#### Algorithm

1. Start with the full directory path (filename is handled separately).
2. If the path fits within `maxWidth`, return it unchanged.
3. Otherwise, replace the middlemost path segment with `"..."`.
4. Iteratively expand the `"..."` range outward from the center — absorbing
the segment closest to the middle of the remaining visible segments — until
the compressed path fits or only `root + "..." + last` remains.

#### Per-file width accounting

The available width for the path is computed **per file row**, not globally.
Each row has a different filename length, so the space left for the path
varies. The widget calculates:

```
pathMaxWidth = lineWidth
  - visibleWidth(gutter)
  - visibleWidth(separator)
  - visibleWidth(filename)
  - visibleWidth(separator)
  - visibleWidth(counter)
  - padding
```

This ensures that a row with a short filename gets more room for the path,
while a row with a long filename gets less — the counter never overruns.

### Parsing Behavior

#### For bash origins

1. Split the full command by pipes (`|`), redirects (`>`, `>>`, `<`), and logical operators (`&&`, `||`, `;`) into discrete subcommand strings.
2. Tokenize each subcommand by whitespace, respecting single and double quotes.
3. The first token is the primary **actor**. Resolve it via `which` or platform-specific discovery.
4. Classify remaining tokens:
   - **actor**: tokens that resolve to executables or scripts (e.g. `.js`, `.ts` files passed to a runtime)
   - **resource**: tokens that look like filesystem paths or URLs; resolve relative paths against `cwd`
   - **arg**: all other tokens treated as generic arguments
5. For `resource` and `actor` tokens, attempt `fs.existsSync` on the resolved absolute path. Set `questionable: 0` if the path exists, `1` otherwise.
6. Exclude tokens that are purely numeric or fail the basename validation regex (`/^(?!\d+$)[A-Za-z0-9._-]+$/`).

#### Path normalisation

All resolved paths (`absolutePath` fields) are run through `path.normalize()` to produce OS-native separators:
  - **Windows**: backslashes (`D:\project\file.md`)
  - **Unix / macOS**: forward slashes (`/home/project/file.md`)

Input candidates (from JSONL or bash tokens) may use either separator style — the resolver accepts forward slashes, backslashes, and mixed forms on any platform. The output is always normalised to the host OS convention. This ensures the library produces correct, platform-appropriate paths whether it runs on Windows, macOS, or Linux.

#### For tool-call origins

The `fullCommand` is already in the shape `<toolName> <JSON-string>`. Parsing:

1. Split on the first space to separate the **tool name** (becomes primary actor) from the remainder.
2. Attempt to parse the remainder as JSON. If it parses, inspect each top-level value:
   - **strings** that match filesystem or URL patterns → `resource`
   - **objects/arrays** → `data` (routed through `dataCallback` if provided, else stored as-is)
   - **primitives** (numbers, booleans, null, short strings) → `arg`
3. If the remainder does not parse as JSON, fall back to bash-style tokenisation.

### CLI Harness (cli.js)

`whatsop/cli.js` accepts a JSONL log file path and replays every recorded invocation through the parser, outputting the full parsed JSON for each line. This allows a human or agent to eyeball results and assess quality.

```bash
node whatsop/cli.js <session-id>.jsonl
```

Each parsed line is printed as pretty-printed JSON so individual nodes can be inspected. The CLI exits with a summary count of lines processed.

### Session Logging (Data Collection)

To enable testing and validation of the normalization library, the extension will record every raw invocation (the original string plus an `origin` marker) to a JSON Lines log file named `<session-id>.jsonl` in the workspace root. Each line will be an object with:

```jsonl
{ "timestamp": "<ISO8601>", "origin": "<bash|tool-call>", "fullCommand": "<original invocation string>" }
```

This log captures a faithful trace of what the agent saw and serves as the source of truth for replaying through `cli.js` and for future analysis.
