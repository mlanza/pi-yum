# @your-org/pi-web-tracker

Tracks the web-based context the agent brings into a session — every HTTP/HTTPS URL detected in tool-call inputs is vetted and URL reads are recorded with per-resource counts.

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
| `/web-approval ask` | Prompt for untrusted URL-bearing calls (any tool call whose arguments include an HTTP/HTTPS URL) |
| `/web-approval approve` | Allow untrusted URL calls without prompts (still shows a warning notification) |
| `/web-approval deny` | Block untrusted URL calls without prompting |
| `/web-approval` or `/web-approval status` | Show current mode (`ask`, `approve`, or `deny`) |
| `/web-approval list` | List trusted URL regex patterns currently in memory (env + session-added) |

## Configuration

Set trusted hosts and default approval mode via environment variables:

```bash
export PI_WEB_TRACKER_TRUSTED_HOST_PATTERNS="pi.dev,github.com,raw.githubusercontent.com"
export PI_WEB_TRACKER_APPROVAL_MODE="deny" # ask | approve | deny
```

- `PI_WEB_TRACKER_TRUSTED_HOST_PATTERNS`: comma-separated host patterns
- `PI_WEB_TRACKER_APPROVAL_MODE`: default mode for untrusted URL handling
- If `PI_WEB_TRACKER_APPROVAL_MODE` is unset/blank, default is `deny`
- On session load, the extension shows either:
  - an info message listing configured trusted host patterns, or
  - a warning when the variable is unset/empty (all domains treated as untrusted)

## Behavior

- Approval gating now applies to any tool call that contains HTTP/HTTPS URLs in its arguments (including newly-installed tools). URL read tracking remains explicit for successful `read("https://…")`, [`webfetch`](https://pi.dev/docs/tools/webfetch), and URL-bearing `bash` commands.
- Optional approval gate: untrusted URL-bearing calls are controlled by `/web-approval ask|approve|deny` (default: `deny`). URLs matching `PI_WEB_TRACKER_TRUSTED_HOST_PATTERNS` bypass the gate. In `ask` mode, the dialog shows the full tool invocation (`toolName(JSON args)`) and offers `Yes`, `No`, or `Add (<root URL>)`; `Add` appends an in-memory regex for the root domain (including subdomains) to the trusted list for the current session. User `No` blocks and terminates the turn. In `deny` mode, calls are blocked immediately with an error (no termination), so the agent can try other options.
- The widget renders as `🌐 | <path> | <domain>` (path is everything after the domain) and sorts entries with the most recently read resources at the top. A right-aligned `📖nnn` counter keeps the numbers tidy. Domains outside `PI_WEB_TRACKER_TRUSTED_HOST_PATTERNS` add a ⚠️ badge and a warning-toned domain so you can pause before trusting new content.
- When more than eight resources are tracked the header switches from `Read resources (N)` to `Read resources (visible/total)` and a dim footer hints at `/web-tracker all`. Use `/web-tracker limit <N>` to raise the cap and reset the footer.
- Historical reads survive restarts because the `fileLimit`, `showAll`, and resource list persist via `pi.appendEntry`.

## Design notes

- A lightweight `pendingWebfetchUrls` map grabs the requested URL at `tool_call` time so the ensuing `tool_result` handler can attribute the read even if a redirect happened.
- Canonical URLs are resolved once and stored with domain/path metadata so the widget can display the domain separately from the resource path.
- The UI mirrors the read-files tracker (header/footer, limit controls, right-aligned counters) so switching between the widgets feels consistent. When you see ⚠️ it signals that the read came from a domain that is not on the tracker’s trusted list, so you may want to double-check any edits that depend on that data.
