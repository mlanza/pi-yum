#!/usr/bin/env -S deno run --allow-read

/**
 * watchman.js - File system watcher with timeout
 * 
 * Usage: deno run --allow-read watchman.js [timeout_seconds]
 * Default timeout: 60 seconds
 * Press CTRL+C to kill
 * 
 * NOTE: Deno.watchFs() does not expose process information (PID, process name).
 * The OS-level FSEvents/inotify APIs don't provide this data, so we can't
 * filter by which process initiated the change.
 */

const DEFAULT_TIMEOUT = 60;

// Parse timeout from command line args
const timeoutSeconds = parseInt(Deno.args[0]) || DEFAULT_TIMEOUT;

// Common directories to ignore (noise reduction)
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  ".pytest_cache",
  "dist",
  "build",
  "target",
  ".cache",
  ".deno",
]);

// Get current working directory
const cwd = Deno.cwd();

console.log(`Starting watchman.js with ${timeoutSeconds} second timeout...`);
console.log(`Watching: ${cwd} (recursively)`);
console.log(`Press CTRL+C to exit.`);

// Set up timeout
const timeoutId = setTimeout(() => {
  console.log(`\nTimeout reached after ${timeoutSeconds} seconds. Exiting.`);
  Deno.exit(0);
}, timeoutSeconds * 1000);

// Track start time for relative timestamps
const startTime = Date.now();

function getTimestamp() {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  return `[+${elapsed}s]`;
}

// Check if path should be ignored
function shouldIgnore(path) {
  const parts = path.split("/");
  for (const part of parts) {
    if (IGNORE_DIRS.has(part)) {
      return true;
    }
  }
  return false;
}

// Watch only the current working directory recursively
const watcher = Deno.watchFs(cwd, { recursive: true });

console.log(`\n${getTimestamp()} File system watcher started\n`);

for await (const event of watcher) {
  // Filter: skip ignored directories
  const relevantPaths = event.paths.filter((p) => !shouldIgnore(p));
  
  if (relevantPaths.length === 0) {
    continue;
  }

  const { kind, paths } = event;
  
  // Note: Event kind can be: "access", "create", "modify", "remove", "rename", "other"
  console.log(`${getTimestamp()} ${kind}: ${relevantPaths.join(", ")}`);
}

// Clean up on interrupt
Deno.addSignalListener("SIGINT", () => {
  console.log("\n\nReceived CTRL+C. Exiting.");
  clearTimeout(timeoutId);
  watcher.close();
  Deno.exit(0);
});