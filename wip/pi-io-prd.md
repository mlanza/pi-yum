# pi-io Extension

A [pi extension](../PROVENANCE-TRACKING-PRD.md) that tracks file I/O operations in the pi TUI widget.

---

## Implementation Status

**In Progress** - Extension implemented, provenance tracking via session files established

---

## Display Modes

- **Touch view**: Aggregate by file/command, show counts and last timestamp
- **Log view**: Chronological list of all operations

### Size Options

- `compact`: 10 entries (min)
- `normal`: 25 entries
- `full`: 1000 entries (max)

### Bash Command Display

- Full command shown (no truncation)
- ANSI color codes stripped on storage
- Multi-line commands shown as single line with `↵ ` for newlines
- Commands shown in orange to distinguish from file paths
- Bash entries grouped by full command (each unique command = separate row)
- Bash commands can be echoed to agent via `io echo` for analysis

---

## Unix Command Semantics (Read vs Write)

Commands are classified by their inherent capability:

**Read-only** (cannot write, ever):
- `cat`, `head`, `tail`, `less`, `more`
- `grep`, `rg`, `wc`, `sort`, `uniq`, `cut`
- `ls`, `find`, `stat`, `which`, `whereis`, `type`
- `md5`, `sha256`, `sha1`, `diff`, `cmp`

**Write-only** (cannot read, ever):
- `echo`, `printf`, `touch`, `mkdir`
- `rm`, `cp`, `mv`, `ln`, `chmod`, `chown`

**Both** (opt-in to write):
- `sed` - read-only by default, `-i` flag enables write
- `perl` - same as sed
- `awk` - read-only by default, can write via output
- `tee` - reads stdin, writes to file AND stdout

**Key insight**: Unix designers were deliberate. Read tools have no write capability. Write tools have no read capability. This makes auditing trivial - if a command can read, it's read-only unless explicitly redirected.

---

## Provenance via Session

The session JSONL file is the complete audit trail. All tool results (including bash command output) are stored verbatim. No need for additional tracking - the session itself is the provenance record.