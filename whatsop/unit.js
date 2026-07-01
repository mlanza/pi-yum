/**
 * core.js — Unit tests
 *
 * Run: node whatsop/unit.js
 * Requires: core.js, JSONL logs in the parent directory
 *
 * Tests:
 *   1. normalize — bash commands (redirects, flags, globs, paths)
 *   2. normalize — tool-call commands (read, edit, write)
 *   3. normalize — edge cases (punctuation, numbers, URLs)
 *   4. compressPath — path compression
 *   5. Integration — replay JSONL logs without errors
 */

import { normalize, compressPath } from "./core.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";


const cwd = process.cwd();

// ─── Test registry ──────────────────────────────────────────────────────────

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function testAsync(name, fn) {
  tests.push({ name, fn, async: true });
}

async function runAll() {
  for (const t of tests) {
    try {
      if (t.async) await t.fn();
      else t.fn();
      passed++;
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${t.name}: ${e.message}`);
    }
  }
  console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
  if (failed > 0) process.exit(1);
}

function getTypes(result) {
  return result.subcommands.flatMap((sc) => sc.args.map((a) => a.type));
}

function findResources(result) {
  return result.subcommands.flatMap((sc) =>
    sc.args.filter((a) => a.type === "resource" || a.type === "actor")
  );
}

// ─── 1. Bash normalization ──────────────────────────────────────────────────

testAsync("cat with file arg classifies file as resource", async () => {
  const r = await normalize({ origin: "bash", fullCommand: "cat notepad.md" }, { cwd });
  const resources = findResources(r);
  assert.ok(resources.length > 0, "expected at least one resource");
  assert.ok(resources.some((a) => a.arg === "notepad.md"));
});

testAsync("cat --help produces zero resources/flags", async () => {
  const r = await normalize({ origin: "bash", fullCommand: "cat --help" }, { cwd });
  const resources = findResources(r);
  assert.equal(resources.length, 0, "--help should not be a resource");
});

testAsync("redirect operators are not resources", async () => {
  const r = await normalize({ origin: "bash", fullCommand: "ls -la 2>/dev/null" }, { cwd });
  const resources = findResources(r);
  const redirects = resources.filter((a) => a.arg.includes(">"));
  assert.equal(redirects.length, 0, "redirect operators should not be resources");
});

testAsync("Windows-style flags are not resources", async () => {
  const r = await normalize({ origin: "bash", fullCommand: "dir /b /s *.ts" }, { cwd });
  const types = getTypes(r);
  assert.ok(!types.includes("resource"), "/b /s should not be resources");
});

testAsync("glob patterns are not actors", async () => {
  const r = await normalize({ origin: "bash", fullCommand: "cat *.ts" }, { cwd });
  const actors = r.subcommands.flatMap((sc) =>
    sc.args.filter((a) => a.type === "actor")
  );
  const globActors = actors.filter((a) => a.arg.includes("*"));
  assert.equal(globActors.length, 0, "glob patterns should not be actors");
});

testAsync("pipe splitting works", async () => {
  const r = await normalize({ origin: "bash", fullCommand: "cat file.txt | grep foo" }, { cwd });
  assert.equal(r.subcommands.length, 2, "expected 2 subcommands from pipe");
});

testAsync("logical operator splitting works", async () => {
  const r = await normalize({ origin: "bash", fullCommand: "cd src && ls -la" }, { cwd });
  assert.equal(r.subcommands.length, 2, "expected 2 subcommands from &&");
});

testAsync("bare word without extension is not a resource", async () => {
  const r = await normalize({ origin: "bash", fullCommand: "grep -rn TODO confirmed" }, { cwd });
  const resources = findResources(r);
  const bareWords = resources.filter((a) => a.arg === "confirmed" || a.arg === "TODO");
  assert.equal(bareWords.length, 0, "bare words without extension should not be resources");
});

testAsync("file with extension is classified as resource", async () => {
  const r = await normalize({ origin: "bash", fullCommand: "cat notepad.md" }, { cwd });
  const resources = findResources(r);
  assert.ok(resources.some((a) => a.arg === "notepad.md" && a.type === "resource"),
    "notepad.md should be classified as resource");
});

testAsync("echo with no file args produces no resources", async () => {
  const r = await normalize({ origin: "bash", fullCommand: "echo hello world" }, { cwd });
  const resources = findResources(r);
  assert.equal(resources.length, 0, "echo with bare words should have no resources");
});

// ─── 2. Tool-call normalization ─────────────────────────────────────────────

testAsync("read with path classifies path as resource", async () => {
  const r = await normalize({
    origin: "tool-call",
    fullCommand: 'read {"path":"notepad.md"}',
  }, { cwd });
  const resources = findResources(r);
  assert.ok(resources.some((a) => a.arg === "notepad.md"),
    "read tool path should be a resource");
});

testAsync("read with absolute path", async () => {
  const absPath = cwd.replace(/\\/g, "/") + "/notepad.md";
  const r = await normalize({
    origin: "tool-call",
    fullCommand: `read {"path":"${absPath}"}`,
  }, { cwd });
  const resources = findResources(r);
  assert.ok(resources.some((a) => a.location && a.location.endsWith("notepad.md")));
});

testAsync("edit with edits array creates data type", async () => {
  const r = await normalize({
    origin: "tool-call",
    fullCommand: 'edit {"edits":[{"oldText":"foo","newText":"bar"}],"path":"file.ts"}',
  }, { cwd });
  const dataArgs = r.subcommands.flatMap((sc) =>
    sc.args.filter((a) => a.type === "data")
  );
  assert.ok(dataArgs.length > 0, "edits array should be classified as data");
  assert.ok(dataArgs[0].data, "data arg should contain the parsed data");
});

testAsync("tool-call with numeric offset/limit are not resources", async () => {
  const r = await normalize({
    origin: "tool-call",
    fullCommand: 'read {"offset":130,"path":"notepad.md","limit":45}',
  }, { cwd });
  const numericArgs = r.subcommands.flatMap((sc) =>
    sc.args.filter((a) => a.type === "resource" && /^\d+$/.test(a.arg))
  );
  assert.equal(numericArgs.length, 0, "numeric values should not be resources");
});

testAsync("batondebug with message arg produces no resources", async () => {
  const r = await normalize({
    origin: "tool-call",
    fullCommand: 'batondebug {"message":"Session resumed. Reading current state."}',
  }, { cwd });
  const resources = findResources(r);
  assert.equal(resources.length, 0, "batondebug message should not be a resource");
});

// ─── 3. Edge cases ──────────────────────────────────────────────────────────

testAsync("empty command produces no crash", async () => {
  const r = await normalize({ origin: "bash", fullCommand: "" }, { cwd });
  assert.ok(Array.isArray(r.subcommands));
});

testAsync("command with only flags produces no resources", async () => {
  const r = await normalize({ origin: "bash", fullCommand: "ls -la -R -t" }, { cwd });
  const resources = findResources(r);
  assert.equal(resources.length, 0, "flags-only command should not produce resources");
});

testAsync("URL is classified as resource", async () => {
  const r = await normalize({
    origin: "bash",
    fullCommand: "curl https://example.com/file.txt",
  }, { cwd });
  const resources = findResources(r);
  assert.ok(resources.some((a) => a.arg === "https://example.com/file.txt"),
    "URL should be classified as resource");
});

testAsync("punctuation-only tokens are not resources", async () => {
  const r = await normalize({
    origin: "bash",
    fullCommand: "echo hello && echo world",
  }, { cwd });
  assert.equal(r.subcommands.length, 2);
  const resources = findResources(r);
  assert.equal(resources.length, 0, "simple echo commands should have no resources");
});

testAsync("cd to directory produces resource", async () => {
  const r = await normalize({
    origin: "bash",
    fullCommand: "cd D:/pi-yum/whatsop",
  }, { cwd });
  const resources = findResources(r);
  assert.ok(resources.some((a) => a.location && a.location.includes("whatsop")),
    "cd to directory should produce resource for the directory");
});

// ─── 4. compressPath ────────────────────────────────────────────────────────

const longPath = process.platform === "win32"
  ? "C:/Users/mlanza/AppData/Roaming/fnm/node-versions/v22.22.3/installation/node_modules/@earendil-works/pi-coding-agent/docs"
  : "/home/user/appdata/roaming/fnm/node-versions/v22.22.3/installation/node_modules/@earendil-works/pi-coding-agent/docs";

test("short path unchanged when it fits", () => {
  const p = compressPath("C:/Users/mlanza", 60);
  assert.ok(p.length <= 60, "short path should fit unchanged");
});

test("long path compressed to fit maxWidth", () => {
  const maxWidth = 60;
  const p = compressPath(longPath, maxWidth);
  assert.ok(p.length <= maxWidth,
    `compressed path (${p}) length ${p.length} exceeds ${maxWidth}`);
});

test("very narrow width still produces valid path", () => {
  const maxWidth = 30;
  const p = compressPath(longPath, maxWidth);
  assert.ok(p.length <= maxWidth,
    `compressed path length ${p.length} exceeds ${maxWidth}`);
  assert.ok(p.includes("..."), "narrow width should force ellision");
  if (process.platform === "win32") {
    assert.ok(p.startsWith("C:"), "Windows path should preserve drive letter");
  }
  assert.ok(p.endsWith("docs"), "should preserve the last path segment");
});

test("single-segment path returns unchanged", () => {
  const p = compressPath("/tmp", 5);
  assert.equal(p, process.platform === "win32" ? "\\tmp" : "/tmp");
});

test("compressPath backslash paths on Windows", () => {
  if (process.platform !== "win32") return;
  const winPath = "C:\\Users\\mlanza\\Projects\\pi-yum\\whatsop";
  const p = compressPath(winPath, 35);
  assert.ok(p.length <= 35, `compressed path length ${p.length} exceeds 35`);
  assert.ok(p.includes("..."), "should ellide middle segments");
});

test("compressPath short enough already returns unchanged", () => {
  const p = compressPath("/usr/bin", 60);
  // "/usr/bin" (8 chars) ≤ 60, so returned unchanged
  assert.equal(p, process.platform === "win32" ? "\\usr\\bin" : "/usr/bin");
});

// ─── 6. fileMemo — collective context oracle ────────────────────────────────

testAsync("fileMemo boosts nonexistent path to resource in bash", async () => {
  const memo = new Set([resolve(cwd, "some-gone-file.md")]);
  const r = await normalize(
    { origin: "bash", fullCommand: "cat some-gone-file.md" },
    { cwd, fileMemo: memo },
  );
  const resources = findResources(r);
  const match = resources.find((a) => a.arg === "some-gone-file.md");
  assert.ok(match, "file in memo should be classified as resource even if absent");
  assert.equal(match.questionable, 0, "memo-confirmed path should have questionable: 0");
});

testAsync("fileMemo boosts nonexistent path to resource in tool-call", async () => {
  const memo = new Set([resolve(cwd, "vanished.py")]);
  const r = await normalize(
    { origin: "tool-call", fullCommand: 'read {"path":"vanished.py"}' },
    { cwd, fileMemo: memo },
  );
  const resources = findResources(r);
  const match = resources.find((a) => a.arg === "vanished.py");
  assert.ok(match, "file in memo should be classified as resource even if absent");
  assert.equal(match.questionable, 0, "memo-confirmed path should have questionable: 0");
  assert.ok(match.location, "memo-confirmed path should include location");
});

testAsync("fileMemo is optional — works without it", async () => {
  // A nonexistent bare word without extension should NOT be a resource when no memo
  const r = await normalize(
    { origin: "bash", fullCommand: "cat no-such-file-without-ext" },
    { cwd },
  );
  const resources = findResources(r);
  const match = resources.find((a) => a.arg === "no-such-file-without-ext");
  assert.ok(!match, "absent bare word without memo should NOT be a resource");
});

testAsync("fileMemo doesn't override flag logic", async () => {
  const memo = new Set([resolve(cwd, "--help")]);
  const r = await normalize(
    { origin: "bash", fullCommand: "cat --help" },
    { cwd, fileMemo: memo },
  );
  const resources = findResources(r);
  // --help starts with "-", so isPathCandidate returns false — memo shouldn't override that
  const match = resources.find((a) => a.arg === "--help");
  assert.ok(!match, "--help should not be a resource even if in memo");
});

// ─── 7. False-positive rejection ───────────────────────────────────────────

testAsync("User-Agent string with parens is not a resource", async () => {
  const r = await normalize({
    origin: "bash",
    fullCommand: 'curl -sL -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" https://boardgamegeek.com',
  }, { cwd });
  // The URL should be classified as a resource
  const urlResources = r.subcommands.flatMap((sc) =>
    sc.args.filter((a) => a.type === "resource" && a.location === "https://boardgamegeek.com")
  );
  assert.ok(urlResources.length > 0, "URL should still be classified as resource");
  // The User-Agent string should NOT be classified as a resource
  const uaResources = r.subcommands.flatMap((sc) =>
    sc.args.filter((a) => a.type === "resource" && a.location && a.location.includes("Mozilla"))
  );
  assert.equal(uaResources.length, 0, "User-Agent string should NOT be a resource");
  // And no filesystem-garbage paths
  const garbagePaths = r.subcommands.flatMap((sc) =>
    sc.args.filter((a) => a.type === "resource" && a.location && a.location.includes(":\\") && a.location.includes("Mozilla"))
  );
  assert.equal(garbagePaths.length, 0, "no filesystem garbage paths from UA string");
});

// ─── 8. URL resources — separate from filesystem paths ──────────────────────

testAsync("URL in bash is classified as resource via location", async () => {
  const r = await normalize({
    origin: "bash",
    fullCommand: "curl https://boardgamegeek.com",
  }, { cwd });
  const matches = r.subcommands.flatMap((sc) =>
    sc.args.filter((a) => a.type === "resource" && a.location === "https://boardgamegeek.com")
  );
  assert.ok(matches.length > 0, "URL should be classified as resource with location");
  assert.equal(matches[0].questionable, 0, "URL resource should have questionable: 0");
});

testAsync("URL with path in bash is classified as resource", async () => {
  const r = await normalize({
    origin: "bash",
    fullCommand: "curl https://example.com/file.txt",
  }, { cwd });
  const resources = findResources(r);
  assert.ok(resources.some((a) => a.arg === "https://example.com/file.txt"),
    "URL with path should be classified as resource");
});

testAsync("URL in tool-call is classified as resource via location", async () => {
  const r = await normalize({
    origin: "tool-call",
    fullCommand: 'read {"path":"https://boardgamegeek.com"}',
  }, { cwd });
  const matches = r.subcommands.flatMap((sc) =>
    sc.args.filter((a) => a.type === "resource" && a.location === "https://boardgamegeek.com")
  );
  assert.ok(matches.length > 0, "URL in tool-call should be classified as resource with location");
});

testAsync("curl --help does not produce a URL resource", async () => {
  const r = await normalize({
    origin: "bash",
    fullCommand: "curl --help",
  }, { cwd });
  const urlResources = r.subcommands.flatMap((sc) =>
    sc.args.filter((a) => a.type === "resource" && a.location && /^https?:\/\//i.test(a.location))
  );
  assert.equal(urlResources.length, 0, "--help should not produce a URL resource");
});

// ─── 5. Integration: replay JSONL logs ──────────────────────────────────────
// Note: these tests are slower (~5-10s per file on Windows) because each
// invocation triggers which/where (execSync) for actor resolution via PATH.
// The 3s timeout on execSync keeps it bounded.

async function replayJsonl(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  let errors = 0;
  for (let i = 0; i < lines.length; i++) {
    let invocation;
    try { invocation = JSON.parse(lines[i]); } catch { errors++; continue; }
    try { await normalize(invocation, { cwd }); }
    catch (e) { errors++; }
  }
  return { total: lines.length, errors };
}

testAsync("JSONL 019f1d9c replays without errors", async () => {
  const { total, errors } = await replayJsonl(
    "019f1d9c-c71b-7c89-81a3-218c67326218.jsonl"
  );
  assert.equal(errors, 0, `${errors} error(s) in ${total} lines`);
});

testAsync("JSONL 019f1dfd replays without errors", async () => {
  const { total, errors } = await replayJsonl(
    "019f1dfd-d69e-7db1-a29e-9c090a3904a7.jsonl"
  );
  assert.equal(errors, 0, `${errors} error(s) in ${total} lines`);
});

testAsync("JSONL 019f1e12 replays without errors", async () => {
  const { total, errors } = await replayJsonl(
    "019f1e12-6e92-7976-9e1d-2d4ed0f66adb.jsonl"
  );
  assert.equal(errors, 0, `${errors} error(s) in ${total} lines`);
});

// ─── Run ────────────────────────────────────────────────────────────────────

await runAll();
