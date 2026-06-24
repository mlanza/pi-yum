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
- Normalizes file paths to absolute before counting.
- Persists state in the session so it survives restarts and branch navigation.
