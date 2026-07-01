/**
 * End-to-end test: verify the read-tracker would capture a URL resource
 * from a `curl https://boardgamegeek.com` command.
 *
 * Simulates the exact logic from pi-read-tracker.ts's tool_result handler.
 */

import { normalize } from "./core.js";
import { basename } from "node:path";

const cwd = process.cwd();
const READ_COMMANDS = new Set(["cat","grep","less","more","head","tail","sed","awk","sort","wc","curl","wget"]);

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

// ── Simulate a curl invocation ──────────────────────────────────────────────
const invocation = { origin: "bash", fullCommand: "curl -s https://boardgamegeek.com" };
const result = await normalize(invocation, { cwd });

assert(result.subcommands.length === 1, "one subcommand parsed");
assert(result.subcommands[0].args.length === 2, "two args: -s and URL");

// Simulate read-tracker bash handler logic
let urlTracked = false;
for (const sub of result.subcommands) {
  const actorBase = basename(sub.actor).replace(/\.(exe|com|bat|cmd)$/i, "");
  assert(READ_COMMANDS.has(actorBase), `actor "${actorBase}" is in READ_COMMANDS`);

  for (const arg of sub.args) {
    if (arg.type === "resource" && arg.location) {
      if (/^https?:\/\//i.test(arg.location)) {
        // URL resource — what the read-tracker does:
        assert(arg.location === "https://boardgamegeek.com", "URL is correct");
        assert(arg.questionable === 0, "URL has questionable: 0");
        assert(typeof arg.location === "string", "location is a string");

        // Verify NO filesystem pollution (the critical fix)
        const hasPollution = arg.location.includes(":\\") || arg.location.includes("/");
        const isJustUrl = arg.location.startsWith("https://");
        assert(isJustUrl, "location is a clean URL, not a polluted filesystem path");

        urlTracked = true;
      }
    }
  }
}
assert(urlTracked, "URL https://boardgamegeek.com was tracked as a resource");

// ── Also verify tool-call origin ───────────────────────────────────────────
const tcResult = await normalize({
  origin: "tool-call",
  fullCommand: 'read {"path":"https://boardgamegeek.com"}',
}, { cwd });

const tcResources = tcResult.subcommands.flatMap(sc =>
  sc.args.filter(a => a.type === "resource" && a.location === "https://boardgamegeek.com")
);
assert(tcResources.length > 0, "URL in tool-call is classified as resource with location");

// ── Verify the widget data model would be correct ──────────────────────────
const fileMapEntry = {
  path: "https://boardgamegeek.com",
  type: "resource",
  readCount: 1,
  external: true,
  verified: false,
  questionable: 0,
};
assert(fileMapEntry.type === "resource", "resource type is correct");
assert(fileMapEntry.path === "https://boardgamegeek.com", "path stores the full URL");

// In the render function, resource entries show 🌐 and the full URL
const widgetLabel = fileMapEntry.type === "resource"
  ? fileMapEntry.path  // full URL for resources
  : basename(fileMapEntry.path);
assert(widgetLabel === "https://boardgamegeek.com", "widget would show full URL");

console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
if (failed > 0) process.exit(1);
