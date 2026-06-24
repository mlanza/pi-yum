# @your-org/pi-web-tracker

Tracks the web-based context the agent brings into a session — every HTTP/HTTPS URL the agent passes through the `read` tool or the `webfetch` utility is recorded along with a per-resource read count.

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

## Behavior

- Tracks `read("https://…")` calls and every successful [`webfetch`](https://pi.dev/docs/tools/webfetch) invocation. The service URL plus any post-redirect final URL are normalized to a canonical form before counting.
- The widget renders as `🌐 | <path> | <domain>` (path is everything after the domain) and sorts entries with the most recently read resources at the top. A right-aligned `📖nnn` counter keeps the numbers tidy.
- When more than eight resources are tracked the header switches from `Read resources (N)` to `Read resources (visible/total)` and a dim footer hints at `/web-tracker all`. Use `/web-tracker limit <N>` to raise the cap and reset the footer.
- Historical reads survive restarts because the `fileLimit`, `showAll`, and resource list persist via `pi.appendEntry`.

## Design notes

- A lightweight `pendingWebfetchUrls` map grabs the requested URL at `tool_call` time so the ensuing `tool_result` handler can attribute the read even if a redirect happened.
- Canonical URLs are resolved once and stored with domain/path metadata so the widget can display the domain separately from the resource path.
- The UI mirrors the read-files tracker (header/footer, limit controls, right-aligned counters) so switching between the widgets feels consistent.
