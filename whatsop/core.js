/**
 * whatsop/core.js – Normalization library for CLI and tool-call invocations.
 *
 * Pure transformation pipeline: each invocation record is mapped into a
 * structured intermediate representation without side effects or mutation.
 *
 * @module whatsop/core
 */

import { existsSync } from "node:fs";
import { basename, isAbsolute, normalize as normalizePath, resolve, sep } from "node:path";
import { execSync } from "node:child_process";

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CWD = process.cwd();

/** Regex for valid bare filenames (excludes pure digits). */
const BASENAME_RX = /^(?!\d+$)[A-Za-z0-9._-]+$/;

/** On Windows, reject short /X patterns that are typically flags, not paths. */
const isWindowsFlag = (str) => {
  if (process.platform !== "win32") return false;
  return /^\/[A-Za-z0-9]{1,3}$/.test(str);
};

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Check if a string looks like a filesystem path (separate from URLs). */
const isPathLike = (str) => {
  // URLs are handled separately — never treat as filesystem path
  if (str.includes("://")) return false;
  // Reject strings with parentheses — these are almost never filesystem paths.
  // User-agent strings, compiler diagnostics, and grep output common patterns
  // that contain parens and path-like separators (e.g. Mozilla/5.0 (...)).
  if (/[()]/.test(str)) return false;
  // Starts with `.`, `/`, `\\`, or `~` (relative/Unix/home prefix)
  if (/^[./\\~]/.test(str)) return true;
  // Contains a path separator
  if (/[\/\\]/.test(str)) return true;
  // Ends with a separator
  if (/[\/\\]$/.test(str)) return true;
  // Consecutive path-like chars (./, .\\, /., //, etc.)
  if (/[./\\][./\\]/.test(str)) return true;
  return false;
};

/** Check if a bare word looks like a filename (matches BASENAME_RX). */
const isBareFileCandidate = (str) => BASENAME_RX.test(str);

/** Check if a string looks like a URL. */
const isUrlCandidate = (str) => {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:";
  } catch { return false; }
};

/** Check if a string could be a resource (path-like, bare filename, or URL). */
const isResourceCandidate = (str) =>
  !!str
  && !str.startsWith("-")
  && !/^\d+$/.test(str)
  && !str.includes("\n")
  && str.length <= 256
  && !isWindowsFlag(str)
  && (isPathLike(str) || isBareFileCandidate(str) || isUrlCandidate(str));

/** True for plain objects (not arrays, not null). */
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * On Windows, convert Git-Bash-style paths (e.g. `/c/Users`, `\\c\\Users`)
 * to proper Windows paths (`C:\\Users`). Must run before isAbsolute so that
 * the result is recognised as absolute on Windows.
 */
const normalizeDriveLetter = (p) => {
  if (process.platform !== "win32") return p;
  return p.replace(/^[/\\]([a-zA-Z])[/\\]/, (_, letter) => letter.toUpperCase() + ":\\");
};

/** Resolve a candidate path against a cwd and normalise to OS-native separators. */
const resolvePath = (candidate, cwd) => {
  const normalized = normalizeDriveLetter(candidate);
  return normalizePath(isAbsolute(normalized) ? normalized : resolve(cwd, normalized));
};

/** Check if a resolved path exists on disk. */
const pathExists = (absPath) => { try { return existsSync(absPath); } catch { return false; } };

/** Try `which` (or `where` on Windows) to resolve a bare command name.
 *
 * Results are cached by command name to avoid repeated subprocess spawns.
 * Use `whichSync._cache` to inspect or clear the cache if needed.
 */
const whichSync = (cmd) => {
  if (whichSync._cache.has(cmd)) return whichSync._cache.get(cmd) ?? null;
  const tool = process.platform === "win32" ? "where" : "which";
  try {
    const out = execSync(`${tool} "${cmd}"`, {
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const result = out.trim().split(/\r?\n/)[0] || null;
    whichSync._cache.set(cmd, result);
    return result;
  } catch {
    whichSync._cache.set(cmd, null);
    return null;
  }
};
whichSync._cache = new Map();

// ─── Bash tokenisation (character-wise, returns new arrays) ─────────────────

/**
 * Split a shell command string by pipe (`|`), semicolon (`;`), and logical
 * operators (`&&`, `||`). Respects single and double quotes.
 * Returns an array of subcommand strings.
 */
const splitSubcommands = (cmd) => {
  const parts = [];
  let cur = "";
  let sq = false, dq = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const nxt = cmd[i + 1] || "";
    if (ch === "'" && !dq) { sq = !sq; cur += ch; continue; }
    if (ch === '"' && !sq) { dq = !dq; cur += ch; continue; }
    if (!sq && !dq) {
      if (ch === "|" && nxt !== "|") { const t = cur.trim(); if (t) parts.push(t); cur = ""; continue; }
      if (ch === ";") { const t = cur.trim(); if (t) parts.push(t); cur = ""; continue; }
      if ((ch === "&" && nxt === "&") || (ch === "|" && nxt === "|")) { const t = cur.trim(); if (t) parts.push(t); cur = ""; i++; continue; }
    }
    cur += ch;
  }
  const t = cur.trim();
  if (t) parts.push(t);
  return parts.length ? parts : [cmd.trim()];
};

/**
 * Tokenize a subcommand string by whitespace, respecting quotes.
 * Returns an array of token strings.
 */
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

// ─── Bash classification (pure) ─────────────────────────────────────────────

/** Classify a single bash token into an ArgNode. */
const classifyBashToken = (token, cwd, fileMemo) => {
  const raw = token.replace(/^(['"])(.*)\1$/, "$2");

  const isActor = /\.(js|ts|mjs|cjs|mts|cts|py|rb|sh|bash|pl|php)$/i.test(raw)
    || ["node","deno","bun","python","python3","ruby","bash","sh","zsh","npx","yarn"].includes(raw);

  // Glob patterns (e.g. *.ts) are not actors — they're shell wildcards
  if (/[*?]/.test(raw)) {
    return { arg: token, type: "arg" };
  }

  if (isActor) {
    const absPath = resolvePath(raw, cwd);
    const exists = pathExists(absPath);
    return { arg: token, type: "actor", absolutePath: exists ? absPath : null, questionable: exists ? 0 : 1 };
  }

  // Shell redirect operators (e.g. 2>/dev/null, >, 2>&1) are not file paths
  if (/^\d*[<>]/.test(raw)) {
    return { arg: token, type: "arg" };
  }

  if (isResourceCandidate(raw)) {
    // URL resources are handled first — never resolve as filesystem path
    if (isUrlCandidate(raw)) {
      return { arg: token, type: "resource", location: raw, questionable: 0 };
    }
    const absPath = resolvePath(raw, cwd);
    const exists = pathExists(absPath);
    if (exists) {
      return { arg: token, type: "resource", location: absPath, questionable: 0 };
    }
    // Not on disk, but the session memo confirms it's a file — trust the oracle.
    if (fileMemo?.has(absPath)) {
      return { arg: token, type: "resource", location: absPath, questionable: 0 };
    }
    // Bare word with no path separators — only keep as resource if it has a
    // file extension or starts with a dot (dotfile). Otherwise it's almost
    // certainly a search pattern, JSON key, or random word, not a file read.
    if (!raw.includes("/") && !raw.includes("\\")) {
      const hasExtension = /\.[A-Za-z0-9]+$/.test(raw);
      if (!hasExtension && !raw.startsWith(".")) {
        const w = whichSync(raw);
        if (w) return { arg: token, type: "actor", absolutePath: w, questionable: 0 };
        return { arg: token, type: "arg" };
      }
    }
    return { arg: token, type: "resource", location: absPath, questionable: 1 };
  }

  return { arg: token, type: "arg" };
};

/** Resolve the primary actor token to a path. */
const resolveActor = (token) => {
  if (token.includes("/") || token.includes("\\")) {
    const abs = resolvePath(token, DEFAULT_CWD);
    return pathExists(abs) ? abs : token;
  }
  return whichSync(token) || token;
};

/** Parse a bash-origin fullCommand into subcommands (pure, returns new array). */
const parseBash = (fullCommand, cwd, fileMemo) =>
  splitSubcommands(fullCommand).flatMap((sc) => {
    const tokens = tokenize(sc);
    if (tokens.length === 0) return [];
    const [actorToken, ...argTokens] = tokens;
    return [{
      actor: resolveActor(actorToken),
      args: argTokens.map((t) => classifyBashToken(t, cwd, fileMemo)),
    }];
  });

// ─── Tool-call classification (pure) ────────────────────────────────────────

/**
 * Classify a single JSON value into an ArgNode.
 * Returns a new node — never mutates.
 */
const classifyJsonValue = (value, cwd, fileMemo) => {
  if (typeof value === "string") {
    if (isResourceCandidate(value)) {
      // URL resources are handled first — never resolve as filesystem path
      if (isUrlCandidate(value)) {
        return { arg: value, type: "resource", location: value, questionable: 0 };
      }
      const absPath = resolvePath(value, cwd);
      const exists = pathExists(absPath);
      if (exists) {
        return { arg: value, type: "resource", location: absPath, questionable: 0 };
      }
      // Not on disk, but the session memo confirms it's a file — trust the oracle.
      if (fileMemo?.has(absPath)) {
        return { arg: value, type: "resource", location: absPath, questionable: 0 };
      }
      // Bare word without extension — not a real file reference.
      if (!value.includes("/") && !value.includes("\\") && !value.startsWith(".")) {
        const hasExtension = /\.[A-Za-z0-9]+$/.test(value);
        if (!hasExtension) return { arg: value, type: "arg" };
      }
      return { arg: value, type: "resource", location: null, questionable: 1 };
    }
    return { arg: value, type: "arg" };
  }
  if (isPlainObject(value) || Array.isArray(value)) {
    return {
      arg: JSON.stringify(value),
      type: "data",
      data: structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value)),
      expanded: [],
    };
  }
  return { arg: String(value), type: "arg" };
};

/**
 * Parse a tool-call origin fullCommand (`<toolName> <JSON-string>`).
 * Returns subcommands array. Pure aside from optional async dataCallback.
 */
const parseToolCall = async (fullCommand, cwd, dataCallback, fileMemo) => {
  const spaceIdx = fullCommand.indexOf(" ");
  const toolName = spaceIdx >= 0 ? fullCommand.slice(0, spaceIdx) : fullCommand;
  const payloadStr = spaceIdx >= 0 ? fullCommand.slice(spaceIdx + 1).trim() : "";

  let parsed;
  try { parsed = JSON.parse(payloadStr); } catch { return parseBash(fullCommand, cwd, fileMemo); }

  // Tool names are logical pi identifiers — skip which/where resolution.
  const actorResolved = toolName;

  // Extract values into a flat list for uniform processing
  const values = isPlainObject(parsed) ? Object.values(parsed)
    : Array.isArray(parsed) ? parsed
    : [parsed];

  const args = await Promise.all(values.map(async (v) => {
    const base = classifyJsonValue(v, cwd, fileMemo);
    if (base.type !== "data" || typeof dataCallback !== "function") return base;
    try {
      const result = await dataCallback(base.data, { actor: toolName, origin: "tool-call", fullCommand });
      return { ...base, expanded: Array.isArray(result) ? result : [] };
    } catch { return { ...base, expanded: [] }; }
  }));

  return [{ actor: actorResolved, args }];
};

// ─── Main API ───────────────────────────────────────────────────────────────

/**
 * Transform a single invocation record into the normalized representation.
 *
 * @param {{origin:string, fullCommand:string, timestamp?:string}} invocation
 * @param {{cwd?:string, dataCallback?:Function, fileMemo?:Set<string>}} [options]
 * @returns {Promise<{fullCommand:string, origin:string, subcommands:Array}>}
 */
export const normalize = async (invocation, options = {}) => {
  const { origin, fullCommand } = invocation;
  const cwd = options.cwd || DEFAULT_CWD;
  const dataCallback = options.dataCallback || null;
  const fileMemo = options.fileMemo;

  const subcommands = origin === "bash"
    ? parseBash(fullCommand, cwd, fileMemo)
    : origin === "tool-call"
      ? await parseToolCall(fullCommand, cwd, dataCallback, fileMemo)
      : parseBash(fullCommand, cwd, fileMemo);

  return { fullCommand, origin, subcommands };
};

// ─── Path compression for display ────────────────────────────────────────────

/**
 * Compress an absolute directory path to fit within maxWidth by elliding
 * middle path segments with "...".
 *
 * The filename is assumed to be handled separately — this function works on
 * the directory portion of a path.
 *
 * Algorithm: start with the full path, check if it fits. If not, replace the
 * middlemost segment with "...". Keep expanding the "..." range outward from
 * the center until the compressed path fits or only root + "..." + last remains.
 *
 * @param {string} dirPath - Absolute directory path (e.g., "C:\\Users\\me\\project\\src")
 * @param {number} maxWidth - Maximum visible width in characters
 * @returns {string} Compressed path
 */
export const compressPath = (dirPath, maxWidth) => {
  const normalized = normalizePath(dirPath);
  if (normalized.length <= maxWidth) return normalized;

  const isWin = process.platform === "win32";
  const segments = normalized.split(sep);

  // Determine root (preserved, never ellided)
  let root, firstIdx;
  if (isWin) {
    root = segments[0] + sep;  // "C:\\"
    firstIdx = 1;
  } else {
    root = sep;                // "/"
    firstIdx = 1;              // segments[0] is ""
  }

  const lastIdx = segments.length - 1;

  // Need at least root + one dir + last dir to have something to compress
  if (lastIdx - firstIdx <= 0) return normalized;

  // Iterative compression: start with middlemost segment, expand outward
  let ellideStart = Math.floor((firstIdx + lastIdx) / 2);
  let ellideEnd = ellideStart;

  while (ellideStart > firstIdx || ellideEnd < lastIdx) {
    const before = segments.slice(0, ellideStart);
    const after = segments.slice(ellideEnd + 1);

    // On Unix, segments[0] is "" — skip it when joining (root is "/")
    const resultParts = isWin ? before : before.filter(s => s !== '');
    const compressed = [...resultParts, "...", ...after].join(sep);
    const finalPath = isWin
      ? compressed
      : (compressed.startsWith(sep) ? compressed : root + compressed);

    if (finalPath.length <= maxWidth) return finalPath;

    // Expand the ellision range: absorb the segment closest to center
    // among remaining non-ellided segments
    const beforeCount = ellideStart - firstIdx;
    const afterCount = lastIdx - ellideEnd;

    if (beforeCount > 0 && (afterCount === 0 || beforeCount >= afterCount)) {
      ellideStart--;
    } else if (afterCount > 0) {
      ellideEnd++;
    } else {
      break;
    }
  }

  // Last resort: root + "..." + last segment
  return root + "..." + sep + segments[lastIdx];
};
