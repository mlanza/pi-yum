/**
 * whatsop/contextualizer.js — Command rewriter for `cd` context.
 *
 * A self-contained, optional pre-processing stage that detects `cd` directives
 * in compound bash commands, consumes them, and rewrites relative file paths
 * in remaining subcommands to absolute paths.
 *
 * FP transform (string → string):
 *   'cd /tmp && cat file.txt' → 'cat /tmp/file.txt'
 *
 * The `cd` is gone from the output.  Every file-like token is fully qualified.
 * Pop this layer off → the command passes through unchanged.
 *
 * Usage:
 *   import { contextualize } from "./contextualizer.js";
 *   const out = contextualize('cd /tmp && cat file.txt', '/home');
 *   // → 'cat /tmp/file.txt'
 *
 * @module whatsop/contextualizer
 */

import { basename, isAbsolute, normalize as normalizePath, resolve } from "node:path";

// ─── Tokenizer (mirrors core.js internals — small, stable) ─────────────────

/**
 * Split a command by logical operators, returning each segment along with the
 * operator that follows it (or "" for the last).  Pipe (`|`) boundaries are
 * tracked so that callers can decide whether cd context carries across.
 *
 * @returns {Array<{text:string, sep:string}>}
 *   sep is "&&" | "||" | ";" | "|" | "" for the final segment.
 */
const splitWithSeparators = (cmd) => {
  const parts = [];
  let cur = "";
  let sq = false, dq = false;

  const emit = (sep) => {
    const t = cur.trim();
    if (t) parts.push({ text: t, sep });
    cur = "";
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const nxt = cmd[i + 1] || "";
    if (ch === "'" && !dq) { sq = !sq; cur += ch; continue; }
    if (ch === '"' && !sq) { dq = !dq; cur += ch; continue; }
    if (!sq && !dq) {
      if (ch === "|" && nxt !== "|") { emit("|"); continue; }
      if (ch === ";") { emit(";"); continue; }
      if (ch === "&" && nxt === "&") { emit("&&"); i++; continue; }
      if (ch === "|" && nxt === "|") { emit("||"); i++; continue; }
    }
    cur += ch;
  }
  emit("");
  return parts.length ? parts : [{ text: cmd.trim(), sep: "" }];
};

/** @deprecated Use splitWithSeparators for pipe-aware splitting. */
const splitSubcommands = (cmd) => splitWithSeparators(cmd).map(s => s.text);

const tokenize = (cmd) => {
  const tokens = [];
  let cur = "";
  let sq = false, dq = false;
  const flush = () => { if (cur) { tokens.push(cur); cur = ""; } };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" && !dq) { sq = !sq; cur += ch; continue; }
    if (ch === '"' && !sq) { dq = !dq; cur += ch; continue; }
    if (!sq && !dq && /\s/.test(ch)) { flush(); continue; }
    cur += ch;
  }
  flush();
  return tokens;
};

// ─── Path helpers ───────────────────────────────────────────────────────────

const normalizeDriveLetter = (p) => {
  if (process.platform !== "win32") return p;
  return p.replace(/^[/\\]([a-zA-Z])[/\\]/, (_, letter) => letter.toUpperCase() + ":\\");
};

const resolvePath = (candidate, cwd) => {
  const normalized = normalizeDriveLetter(candidate);
  return normalizePath(isAbsolute(normalized) ? normalized : resolve(cwd, normalized));
};

/** Quote a path if it contains spaces or shell metacharacters. */
const shellQuote = (p) => {
  const s = p.replace(/\\/g, "/"); // normalize separators for the rewritten command
  return /[\s"']/.test(s) ? `"${s}"` : s;
};

// ─── File-likeness heuristics (subset of core.js classifyBashToken) ────

const BASENAME_RX = /^(?!\d+$)[A-Za-z0-9._-]+$/;

const isWindowsFlag = (str) => {
  if (process.platform !== "win32") return false;
  return /^\/[A-Za-z0-9]{1,3}$/.test(str);
};

const isPathLike = (str) => {
  if (str.includes("://")) return false;
  if (/[()]/.test(str)) return false;
  if (/^[./\\~]/.test(str)) return true;
  if (/[\/\\]/.test(str)) return true;
  if (/[\/\\]$/.test(str)) return true;
  if (/[./\\][./\\]/.test(str)) return true;
  return false;
};

const isBareFileCandidate = (str) => BASENAME_RX.test(str);

const isUrlCandidate = (str) => {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:";
  } catch { return false; }
};

/**
 * Heuristic: does this string look like a filesystem path, URL, or bare filename?
 * Mirrors the logic in core.js's classifyBashToken so the contextualizer makes
 * the same classification decisions about what to rewrite.
 */
const isFileCandidate = (str) =>
  !!str
  && !str.startsWith("-")
  && !/^\d+$/.test(str)
  && !str.includes("\n")
  && str.length <= 256
  && !isWindowsFlag(str)
  && (isPathLike(str) || isBareFileCandidate(str) || isUrlCandidate(str));

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Transform a compound bash command by consuming `cd` directives and rewriting
 * relative file paths to absolute ones.
 *
 * @param {string} fullCommand  Raw bash command (e.g. 'cd /tmp && cat f.txt')
 * @param {string} cwd          Absolute path of the starting working directory
 * @returns {string}            Transformed command with cd absorbed and paths
 *                              made absolute.  If no cd is present, returns the
 *                              original string unchanged.
 *
 * @example
 *   contextualize('cd /tmp && cat f.txt', '/home')
 *   // → 'cat /tmp/f.txt'
 *
 *   contextualize('cat f.txt', '/home')
 *   // → 'cat f.txt'  (unchanged — no cd)
 *
 *   contextualize('cd /a && cd b && cat f', '/home')
 *   // → 'cat /a/b/f'  (chained cds resolved)
 */
export function contextualize(fullCommand, cwd) {
  const segments = splitWithSeparators(fullCommand);
  if (segments.length <= 1) {
    // Single subcommand — no cd possible (cd alone doesn't read files)
    return fullCommand;
  }

  const outParts = [];
  let virtualCwd = cwd;
  let cdWasConsumed = false;

  for (const { text: segment, sep } of segments) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;

    const [actorToken, ...argTokens] = tokens;
    const actorBase = basename(actorToken)
      .replace(/\.(exe|com|bat|cmd)$/i, "")
      .toLowerCase();

    if (actorBase === "cd") {
      // ── Consume the cd — update virtualCwd, don't emit ──────────────
      cdWasConsumed = true;
      if (argTokens.length > 0) {
        const cdTargetRaw = argTokens[0];
        const cdTarget = cdTargetRaw.replace(/^(['"])(.*)\1$/, "$2");
        if (cdTarget && !cdTarget.startsWith("-")) {
          // Trust the command: the agent just ran it successfully, so the
          // directory was valid at that time. No existsSync check needed.
          virtualCwd = resolvePath(cdTarget, virtualCwd);
        }
      }
      // cd does not appear in output
      // Pipe boundaries reset the virtual cwd even for cd segments,
      // because the cd ran in a subshell (left side of pipe).
      if (sep === "|") {
        virtualCwd = cwd;
      }
      continue;
    }

    // ── Rewrite file-like tokens to absolute paths ────────────────────
    const rewritten = argTokens.map((t) => {
      const raw = t.replace(/^(['"])(.*)\1$/, "$2");

      // URLs pass through as-is
      if (isUrlCandidate(raw)) return t;

      // Shell redirect operators (2>/dev/null, >, 2>&1) pass through
      if (/^\d*[<>]/.test(raw)) return t;

      // Glob patterns pass through (the shell expands them)
      if (/[*?]/.test(raw)) return t;

      // Windows flags (/X) pass through
      if (isWindowsFlag(raw)) return t;

      // Check if this looks like a file path
      if (isFileCandidate(raw)) {
        const absPath = resolvePath(raw, virtualCwd);
        return shellQuote(absPath);
      }

      return t; // not file-like — leave unchanged
    });

    outParts.push([actorToken, ...rewritten].join(" "));

    // ── Pipe boundaries reset the virtual cwd ─────────────────────────
    // Pipes run concurrently in separate subshells, so cd in one pipe
    // segment must not affect subsequent segments.  The reset happens
    // AFTER emitting this segment, so cd consumed above doesn't leak.
    if (sep === "|") {
      virtualCwd = cwd;
    }
  }

  if (cdWasConsumed) {
    return outParts.join(" && ");
  }
  return fullCommand;
}

/**
 * Convenience: process all `cd` directives and return just the final effective
 * cwd after the full command runs. Never throws.
 */
export function finalCwd(fullCommand, initialCwd) {
  let virtualCwd = initialCwd;
  const segments = splitWithSeparators(fullCommand);

  for (const { text: segment, sep } of segments) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    const [actorToken, ...argTokens] = tokens;
    const actorBase = basename(actorToken).replace(/\.(exe|com|bat|cmd)$/i, "").toLowerCase();
    if (actorBase === "cd" && argTokens.length > 0) {
      const cdTarget = argTokens[0].replace(/^(['"])(.*)\1$/, "$2");
      if (cdTarget && !cdTarget.startsWith("-")) {
        virtualCwd = resolvePath(cdTarget, virtualCwd);
      }
    }
    // Pipe resets cwd for subsequent segments
    if (sep === "|") virtualCwd = initialCwd;
  }
  return virtualCwd;
}
