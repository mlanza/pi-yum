# @your-org/pi-web-tracker

Tracks the web-based context the agent brings into a session — every HTTP/HTTPS URL seen through `read`, `webfetch`, or URL-bearing `bash` commands is recorded with a per-resource read count.

## Install (development)

Copy `pi-web-tracker.ts` (or your compiled JS) into the extensions directory:

```bash
cp pi-web-tracker.ts ~/.pi/agent/extensions/web-tracker/index.ts
```

Reload Pi with `/reload` if it is already running.

## Commands

| Command             | Effect                                                                    |
|---------------------|---------------------------------------------------------------------------|
| `/web-tracker`     | Toggle the network-resource widget on/off                                 |
| `/web-tracker clear` | Clear the tracked network resources list                                   |
| `/web-tracker all` | Toggle show-all mode to reveal every tracked resource                      |
| `/web-tracker limit <N>` | Set the visible-resource limit (default: `8`) and exit show-all mode          |

## Configuration

Set trusted hosts via environment variable:

```bash
export PI_WEB_TRACKER_TRUSTED_HOST_PATTERNS="pi.dev,github.com,raw.githubusercontent.com"
```

- Format: comma-separated host patterns
- No defaults are applied by the extension
- On session load, the extension shows either:
  - an info message listing configured trusted host patterns, or
  - a warning when the variable is unset/empty (all domains treated as untrusted)

## Behavior

- Tracks `read("https://…")` calls, every successful [`webfetch`](https://pi.dev/docs/tools/webfetch) invocation, and successful `bash` calls whose command string contains one or more `http://` / `https://` URLs (for example `curl`, `wget`, or PowerShell web calls run from shell).
- The widget renders as `🌐 | <path> | <domain>` (path is everything after the domain) and sorts entries with the most recently read resources at the top. A right-aligned `📖nnn` counter keeps the numbers tidy. Domains outside `PI_WEB_TRACKER_TRUSTED_HOST_PATTERNS` add a ⚠️ badge and a warning-toned domain so you can pause before trusting new content.
- When more than eight resources are tracked the header switches from `Read resources (N)` to `Read resources (visible/total)` and a dim footer hints at `/web-tracker all`. Use `/web-tracker limit <N>` to raise the cap and reset the footer.
- Historical reads survive restarts because the `fileLimit`, `showAll`, and resource list persist via `pi.appendEntry`.

## Design notes

- A lightweight `pendingWebfetchUrls` map grabs the requested URL at `tool_call` time so the ensuing `tool_result` handler can attribute the read even if a redirect happened.
- Canonical URLs are resolved once and stored with domain/path metadata so the widget can display the domain separately from the resource path.
- The UI mirrors the read-files tracker (header/footer, limit controls, right-aligned counters) so switching between the widgets feels consistent. When you see ⚠️ it signals that the read came from a domain that is not on the tracker’s trusted list, so you may want to double-check any edits that depend on that data.
