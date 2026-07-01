/**
 * Read Tracker Extension
 *
 * Displays a persistent widget above the text input listing every file
 * the agent has read during the current session, along with per-file read counts.
 *
 * Commands:
 *   /read-tracker                – toggle widget visibility
 *   /read-tracker clear          – clear tracked files from current session
 *   /read-tracker all            – toggle showing every tracked file
 *   /read-tracker limit <N>       – cap visible files, exit show-all mode
 *   /read-tracker audit        – interactively pick a file and trace its commands
 *
 * Source: pi-read-tracker.ts
 * Deploy: ~/.pi/agent/extensions/read-tracker/index.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appendFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";


// ─── Data model ─────────────────────────────────────────────────────────────

type ReadType = "file" | "resource";

interface FileReadStats {
  /** Absolute path for files; URL for network resources */
  path: string;
  /** Distinguishes local files from network resources */
  type: ReadType;
  /** How many times this file has been read */
  readCount: number;
  /** Whether the file lives outside the current session cwd (files only) */
  external: boolean;
  /** Whether the path exists on disk (files only) */
  verified: boolean;
  /** Timestamp (ms) of the most recent read */
  lastRead: number;
  /** Whether the read is a conjectural/partial inference */
  questionable: boolean;
}

interface PersistedState {
  files: FileReadStats[];
  enabled: boolean;
  fileLimit?: number;
  showAll?: boolean;
  auditLog?: Record<string, AuditEntry[]>;
}

// ─── Audit trail ────────────────────────────────────────────────────────────

interface AuditEntry {
  /** Milliseconds since epoch */
  timestamp: number;
  /** Invocation source: "bash" or "tool-call" */
  origin: string;
  /** The full raw command string */
  fullCommand: string;
  /** Unique tool-call identifier (groups all files touched by the same command) */
  toolCallId?: string;
}

/** Map from file path → audit entries for every command that touched it */
const commandAuditLog = new Map<string, AuditEntry[]>();

// ─── Helpers ────────────────────────────────────────────────────────────────

function recordAudit(filePath: string, origin: string, fullCommand: string, timestamp?: number, toolCallId?: string): void {
  const entry: AuditEntry = { timestamp: timestamp ?? Date.now(), origin, fullCommand, toolCallId };
  const entries = commandAuditLog.get(filePath);
  if (entries) {
    entries.push(entry);
  } else {
    commandAuditLog.set(filePath, [entry]);
  }
}

interface DiscoveredFile {
  absPath: string;
  type: ReadType;
  external: boolean;
  verified: boolean;
  questionable: boolean;
}

/**
 * Deterministic short hash from a string, truncated to `len` characters.
 * Uses a simple DJB2-style hash for speed and cross-platform consistency.
 */
function shortHash(text: string, len: number): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  // Convert to positive hex string and truncate
  return (Math.abs(hash) >>> 0).toString(36).slice(0, len).padStart(len, "0");
}

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// ─── JSONL data collection ───────────────────────────────────────────────────

let sessionLogPath: string | null = null;

function logInvocation(origin: string, fullCommand: string): void {
  if (!sessionLogPath) return;
  try {
    appendFileSync(
      sessionLogPath,
      JSON.stringify({ timestamp: new Date().toISOString(), origin, fullCommand }) + "\n",
      "utf-8",
    );
  } catch {
    // Logging is best-effort; must never break the tracker
  }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function isExternalPath(absPath: string, cwd: string): boolean {
  const rel = relative(cwd, absPath);
  if (!rel) return false;
  const first = rel.split(/[\\/]/)[0];
  return first === "..";
}

const VALID_FILENAME_RX = /^[A-Za-z0-9._-]+$/;
const READ_COMMANDS = new Set(["cat","grep","less","more","head","tail","sed","awk","sort","wc","curl","wget"]);
const QUESTIONABLE_READ_COMMANDS = new Set(["rg"]);

type PathTransform = (value: string, cwd: string) => string;

const normalizeSlashes: PathTransform = (value, _cwd) => value.replace(/[\\/]+/g, "/");
const ensureAbsolutePath: PathTransform = (value, cwd) => isAbsolute(value) ? value : resolve(cwd, value);

/**
 * On Windows, convert Git-Bash-style paths (e.g. `/c/Users`, `\\c\\Users`)
 * to proper Windows paths (`C:/Users`). This must run BEFORE ensureAbsolutePath
 * so that `isAbsolute` recognises the result.
 */
const normalizeDriveLetter: PathTransform = (value, _cwd) => {
  if (process.platform !== "win32") return value;
  return value.replace(/^[/\\]([a-zA-Z])[/\\]/, (_, letter) => `${letter.toUpperCase()}:/`);
};

function composePathTransforms(...steps: PathTransform[]): PathTransform {
  return (value, cwd) => steps.reduce((result, step) => step(result, cwd), value);
}

const toCanonicalAbsPath = composePathTransforms(
  normalizeSlashes,
  normalizeDriveLetter,
  ensureAbsolutePath,
  normalizeSlashes,
);

function resolveFileCandidate(candidate: string, cwd: string): { path: string; filename: string; verified: boolean } | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  const absolute = toCanonicalAbsPath(trimmed, cwd);
  const filename = basename(absolute);
  if (!VALID_FILENAME_RX.test(filename)) return undefined;
  let verified = false;
  try {
    verified = existsSync(absolute);
  } catch {
    verified = false;
  }
  // Reject bare-word basenames that don't exist — likely search patterns, not files.
  if (!verified) {
    const hasExtension = /\.[A-Za-z0-9]+$/.test(filename);
    const isDotfile = filename.startsWith(".");
    if (!hasExtension && !isDotfile) return undefined;
  }
  return { path: absolute, filename, verified };
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function readTracker(pi: ExtensionAPI): void {
  const fileMap = new Map<string, FileReadStats>();
  /** Simple oracle: absolute paths confirmed as files this session. No extra deps. */
  const fileMemo = new Set<string>();
  let widgetEnabled = true;
  let fileLimit = 8;
  let showAll = false;
  let cwd = process.cwd();
  // Capture bash commands for read inference
  const pendingBashCommands = new Map<string, string>();

  // ─── Message renderer for audit output ───────────────────────────────────
  pi.registerMessageRenderer("read-tracker-audit", (message, _options, theme) => {
    let text = typeof message.content === "string" ? message.content : "";
    // Replace \x01…\x02 markers with dim-styled short hash
    text = text.replace(/\x01(.+?)\x02/g, (_, hash) => theme.fg("dim", hash));
    return new Text(text, 0, 0);
  });

  // ─── CLI flag: JSONL session logging ─────────────────────────────────────
  pi.registerFlag("read-tracker-log", {
    description: "Enable JSONL invocation logging to <session-id>.jsonl",
    type: "boolean",
    default: false,
  });
  let loggingEnabled = false;

  // ─── Whatsop lazy integration ───────────────────────────────────────────
  let _whatsopNormalize:
    | ((inv: any, opts?: any) => Promise<any>)
    | null
    | undefined;
  let _compressPath:
    | ((dirPath: string, maxWidth: number) => string)
    | null
    | undefined;
  /** Guard against concurrent on-demand audit reconstructions. */
  let _reconstructionInProgress = false;

  /** Lazy-load whatsop from the workspace directory. */
  async function _loadWhatsop(): Promise<typeof _whatsopNormalize> {
    if (_whatsopNormalize !== undefined) return _whatsopNormalize;
    try {
      const mod = await import(pathToFileURL(join(cwd, "whatsop/core.js")).href);
      _whatsopNormalize = mod.normalize;
      _compressPath = mod.compressPath ?? null;
    } catch {
      _whatsopNormalize = null;
      _compressPath = null;
    }
    return _whatsopNormalize;
  }

  /**
   * Compress a directory path to fit within available width using whatsop's
   * compressPath, falling back to the raw path if unavailable.
   */
  function _compressPathLabel(pathLabel: string, availWidth: number): string {
    if (!pathLabel || !_compressPath || !isAbsolute(pathLabel)) return pathLabel;
    try {
      return _compressPath(pathLabel, availWidth);
    } catch {
      return pathLabel;
    }
  }

  /**
   * Expand structured data args (type "data") into ArgNodes.
   * Extracts "path" / "file" fields from known tool payloads.
   */
  async function _dataCallback(
    data: unknown,
    meta: { actor: string; origin: string },
  ): Promise<any[]> {
    if (meta.origin !== "tool-call") return [];
    if (typeof data === "string") {
      const resolved = resolveFileCandidate(data, cwd);
      if (resolved) {
        return [
          {
            arg: data,
            type: "resource",
            location: resolved.path,
            questionable: resolved.verified ? 0 : 1,
          },
        ];
      }
      return [];
    }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      const pathVal = obj.path ?? obj.file;
      if (typeof pathVal === "string") {
        const resolved = resolveFileCandidate(pathVal, cwd);
        if (resolved) {
          return [
            {
              arg: pathVal,
              type: "resource",
              location: resolved.path,
              questionable: resolved.verified ? 0 : 1,
            },
          ];
        }
      }
    }
    return [];
  }

  function persistState(): void {
    const auditLog: Record<string, AuditEntry[]> = {};
    for (const [path, entries] of commandAuditLog) {
      auditLog[path] = entries;
    }
    pi.appendEntry("read-tracker", {
      files: [...fileMap.values()],
      enabled: widgetEnabled,
      fileLimit,
      showAll,
      auditLog: Object.keys(auditLog).length > 0 ? auditLog : undefined,
    } satisfies PersistedState);
  }

  async function restoreFromSession(ctx: ExtensionContext): Promise<void> {
    fileMap.clear();
    fileMemo.clear();
    commandAuditLog.clear();
    const entries = ctx.sessionManager.getBranch();
    let lastState: PersistedState | undefined;
    for (const entry of entries) {
      if (entry.type === "custom" && (entry as any).customType === "read-tracker") {
        lastState = (entry as any).data;
      }
    }
    if (lastState) {
      widgetEnabled = lastState.enabled ?? true;
      fileLimit = lastState.fileLimit ?? 8;
      showAll = lastState.showAll ?? false;
      // Restore audit log
      if (lastState.auditLog) {
        for (const [path, entries] of Object.entries(lastState.auditLog)) {
          commandAuditLog.set(path, entries);
        }
      }
      for (const f of lastState.files ?? []) {
        const readType: ReadType = f.type === "resource" ? "resource" : "file";
        // Skip entries with parenthesized paths — they are old false positives
        // from the pre-location era where User-Agent strings were classified as
        // filesystem paths (e.g. "Mozilla/5.0 (Windows NT...)").
        if (typeof f.path === "string" && /[()]/.test(f.path)) continue;

        // If we have an audit trail for this file, reconcile readCount to match
        // (each distinct command is one read — no double-counting)
        const auditLog = commandAuditLog.get(f.path);
        const reconciledCount = auditLog ? auditLog.length : (typeof f.readCount === "number" ? f.readCount : 1);

        if (readType === "resource") {
          // Resources stored as-is — no filesystem validation
          fileMap.set(f.path, {
            path: f.path,
            type: "resource",
            readCount: reconciledCount,
            external: true,
            verified: false,
            lastRead: typeof f.lastRead === "number" ? f.lastRead : 0,
            questionable: Boolean(f.questionable),
          });
        } else {
          const resolved = resolveFileCandidate(f.path, cwd);
          if (!resolved) continue;
          const normalized: FileReadStats = {
            path: resolved.path,
            type: "file",
            readCount: reconciledCount,
            external: isExternalPath(resolved.path, cwd),
            verified: Boolean(f.verified) || resolved.verified,
            lastRead: typeof f.lastRead === "number" ? f.lastRead : 0,
            questionable: Boolean(f.questionable),
          };
          fileMap.set(normalized.path, normalized);
          // Seed the file memo from verified paths
          if (normalized.verified) fileMemo.add(normalized.path);
        }
      }
    }

    // Note: Audit trail reconstruction is NOT done on session restore.
    // It happens on-demand when the user invokes /read-tracker audit, so
    // that session resume stays fast.  See the audit handler below.
  }

  function updateWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const files = [...fileMap.values()];
    if (!widgetEnabled || files.length === 0) {
      ctx.ui.setWidget("read-tracker", undefined);
      return;
    }

    const sorted = [...files];
    const cwdSnap = cwd;
    sorted.sort((a, b) => (b.lastRead ?? 0) - (a.lastRead ?? 0));

    const totalCount = sorted.length;
    const limitCap = Math.max(1, fileLimit);
    const displayCount = showAll ? totalCount : Math.min(limitCap, totalCount);
    const hiddenCount = totalCount - displayCount;
    const visibleFiles = sorted.slice(0, displayCount);

    ctx.ui.setWidget("read-tracker", (_tui, theme) => {
      let cachedLines: string[] | undefined;
      let cachedWidth: number | undefined;

      return {
        render(width: number): string[] {
          if (cachedLines && cachedWidth === width) return cachedLines;
          const lines: string[] = [];

          // Header
          const title = hiddenCount === 0
            ? ` Read files (${totalCount}) `
            : ` Read files (${displayCount}/${totalCount}) `;
          const titleColored = theme.fg("accent", title);
          const borderLen = Math.max(0, width - visibleWidth(title));
          const borderLeft = theme.fg("borderMuted", "─".repeat(2));
          const borderRight = theme.fg("borderMuted", "─".repeat(Math.max(0, borderLen - 2)));
          lines.push(truncateToWidth(`${borderLeft}${titleColored}${borderRight}`, width));

          // File rows
          for (const f of visibleFiles) {
            const filename = f.type === "resource"
              ? f.path  // show the full URL for network resources
              : basename(f.path);
            const dimSep = theme.fg("dim", " | ");
            const gutterParts: string[] = [];
            if (f.questionable) gutterParts.push("❓");
            if (f.type === "resource") gutterParts.push("🌐");
            if (f.type === "file" && f.external) gutterParts.push("⚠️");
            const gutter = gutterParts.length ? `${gutterParts.join("")} ` : "   ";

            let fileStr: string;
            let pathStr = "";
            let countStr: string;

            if (f.type === "resource") {
              // Network resource — no filesystem ops, show URL directly
              fileStr = theme.fg("accent", filename);
              countStr = theme.fg("warning", `📖${f.readCount.toString().padStart(3, " ")}`);
            } else {
              // File — existing filesystem-aware rendering
              const parentAbs = dirname(f.path);
              const exists = (() => {
                try {
                  return existsSync(f.path);
                } catch {
                  return false;
                }
              })();
              const isVerified = f.verified || exists;
              const normCwd = normalizeSlashes(cwdSnap, cwdSnap).replace(/[\\/]+$/, "");
              const normParent = normalizeSlashes(parentAbs, cwdSnap).replace(/[\\/]+$/, "");
              const isDirectChild = normParent === normCwd;
              const parentRelative = isDirectChild
                ? ""
                : normalizeSlashes(relative(cwdSnap, parentAbs), cwdSnap);
              const pathLabel = isDirectChild
                ? ""
                : f.external
                  ? parentAbs
                  : parentRelative;
              fileStr = isVerified
                ? theme.fg("accent", theme.bold(filename))
                : theme.fg("muted", theme.bold(filename));
              countStr = theme.fg("warning", `📖${f.readCount.toString().padStart(3, " ")}`);

              if (pathLabel) {
                const pathAvailWidth = Math.max(5, width
                  - visibleWidth(gutter)
                  - visibleWidth(dimSep)
                  - visibleWidth(fileStr)
                  - visibleWidth(dimSep)
                  - visibleWidth(countStr)
                  - 2);
                const compressed = _compressPathLabel(pathLabel, pathAvailWidth);
                pathStr = theme.fg("dim", compressed);
              }
            }

            const leftPart = pathStr
              ? `${gutter}${dimSep}${fileStr}${dimSep}${pathStr}`
              : `${gutter}${dimSep}${fileStr}`;

            const gap = Math.max(1, width - visibleWidth(leftPart) - visibleWidth(countStr));
            lines.push(truncateToWidth(`${leftPart}${" ".repeat(gap)}${countStr}`, width));
          }

          if (hiddenCount > 0) {
            const moreMsg = ` … ${hiddenCount} older file${hiddenCount !== 1 ? "s" : ""} hidden · /read-tracker all`;
            lines.push(truncateToWidth(theme.fg("dim", moreMsg), width));
          }

          cachedLines = lines;
          cachedWidth = width;
          return lines;
        },
        invalidate(): void {
          cachedLines = undefined;
          cachedWidth = undefined;
        },
      };
    });
  }

  function accumulateRead(
    absPath: string,
    external: boolean,
    verified: boolean,
    questionable = false,
    auditOrigin?: string,
    auditCommand?: string,
    dedupSet?: Set<string>,
    toolCallId?: string,
  ): void {
    // Skip if already counted in this invocation (dedup within a single command)
    if (/[()]/.test(absPath)) return;
    if (dedupSet?.has(absPath)) return;
    dedupSet?.add(absPath);
    const now = Date.now();
    const existing = fileMap.get(absPath);
    if (existing) {
      existing.readCount++;
      existing.external = existing.external || external;
      existing.questionable = existing.questionable || questionable;
      if (verified) existing.verified = true;
      existing.lastRead = now;
    } else {
      fileMap.set(absPath, {
        path: absPath,
        type: "file",
        readCount: 1,
        external,
        verified,
        lastRead: now,
        questionable,
      });
    }
    if (auditOrigin && auditCommand) {
      recordAudit(absPath, auditOrigin, auditCommand, undefined, toolCallId);
    }
  }

  function trackReadCandidate(
    candidate: string,
    questionable = false,
    auditOrigin?: string,
    auditCommand?: string,
    dedupSet?: Set<string>,
  ): boolean {
    const resolved = resolveFileCandidate(candidate, cwd);
    if (!resolved) return false;
    const external = isExternalPath(resolved.path, cwd);
    accumulateRead(resolved.path, external, resolved.verified, questionable, auditOrigin, auditCommand, dedupSet);
    return true;
  }

  function trackUrlResource(url: string, questionable: boolean, auditOrigin?: string, auditCommand?: string, dedupSet?: Set<string>, toolCallId?: string): void {
    // Skip if already counted in this invocation (dedup within a single command)
    if (dedupSet?.has(url)) return;
    dedupSet?.add(url);
    const now = Date.now();
    const existing = fileMap.get(url);
    if (existing) {
      existing.readCount++;
      existing.lastRead = now;
    } else {
      fileMap.set(url, {
        path: url,
        type: "resource",
        readCount: 1,
        external: true,
        verified: false,
        lastRead: now,
        questionable,
      });
    }
    if (auditOrigin && auditCommand) {
      recordAudit(url, auditOrigin, auditCommand, undefined, toolCallId);
    }
  }

  /**
   * Shared file-discovery logic — used both by the live tool_result handler and
   * by audit reconstruction during session restore.  Runs whatsop normalisation
   * (if available) then falls back to manual heuristics, returning the set of
   * files that would be tracked for this invocation.  Does NOT mutate fileMap
   * or commandAuditLog — that is the caller's responsibility.
   */
  async function discoverTrackedFiles(
    origin: "bash" | "tool-call",
    fullCommand: string,
    toolName: string,
    input: Record<string, any> | undefined,
  ): Promise<DiscoveredFile[]> {
    // ── Early out: non-read commands never produce resources ──────────────
    // This avoids running the expensive whatsop normalize (which spawns
    // subprocesses via which/where) for every edit, write, node, npm, etc.
    if (origin === "tool-call" && toolName !== "read") return [];
    if (origin === "bash") {
      // A bash command may be compound (cd X && cat Y, echo | grep foo, etc.).
      // Check whether ANY subcommand in the chain is a known READ command.
      // Split by logical operators and pipes — cheap, no tokenizer needed just for filtering.
      const chainParts = fullCommand.trim().split(/\s*(?:&&|\|\||;)\s*/);
      const hasReadCommand = chainParts.some((part) => {
        // Also split pipes within each logical part
        const pipeParts = part.split(/\s*\|\s*/);
        return pipeParts.some((p) => {
          const firstWord = p.trim().split(/\s+/)[0] || "";
          const base = firstWord.includes("/")
            ? firstWord.slice(firstWord.lastIndexOf("/") + 1)
            : firstWord;
          return READ_COMMANDS.has(base) || QUESTIONABLE_READ_COMMANDS.has(base);
        });
      });
      if (!hasReadCommand) return [];
    }

    const files: DiscoveredFile[] = [];
    const dedupSet = new Set<string>();
    let trackedByWhatsop = false;

    /** Feed fileMemo and extract DiscoveredFile[] from a normalize result. */
    const ingestNormalizeResult = (result, resultOrigin) => {
      // Feed the memo
      for (const sub of result.subcommands ?? []) {
        for (const arg of sub.args ?? []) {
          if (arg.type === "resource" && arg.location && arg.questionable === 0 && !/^https?:\/\//i.test(arg.location)) {
            fileMemo.add(arg.location);
          }
          if (arg.type === "data" && arg.expanded) {
            for (const ea of arg.expanded) {
              if (ea.type === "resource" && ea.location && ea.questionable === 0 && !/^https?:\/\//i.test(ea.location)) {
                fileMemo.add(ea.location);
              }
            }
          }
        }
      }

      for (const sub of result.subcommands ?? []) {
        // For tool-call origins, only track the "read" tool
        if (resultOrigin === "tool-call" && toolName !== "read") continue;
        // For bash origins, only track known read commands
        if (resultOrigin === "bash") {
          const actorBase = basename(sub.actor).replace(/\.(exe|com|bat|cmd)$/i, "");
          if (!READ_COMMANDS.has(actorBase) && !QUESTIONABLE_READ_COMMANDS.has(actorBase)) continue;
        }

        const isQuestionable =
          resultOrigin === "bash" &&
          sub.actor &&
          QUESTIONABLE_READ_COMMANDS.has(basename(sub.actor).replace(/\.(exe|com|bat|cmd)$/i, ""));

        for (const arg of sub.args ?? []) {
          if (arg.type === "resource" && arg.location) {
            if (/^https?:\/\//i.test(arg.location)) {
              if (dedupSet.has(arg.location)) continue;
              dedupSet.add(arg.location);
              files.push({ absPath: arg.location, type: "resource", external: true, verified: false, questionable: isQuestionable || arg.questionable === 1 });
              trackedByWhatsop = true;
            } else {
              const resolved = resolveFileCandidate(arg.location, cwd);
              if (resolved && !dedupSet.has(resolved.path)) {
                dedupSet.add(resolved.path);
                files.push({ absPath: resolved.path, type: "file", external: isExternalPath(resolved.path, cwd), verified: resolved.verified || existsSync(resolved.path), questionable: isQuestionable || arg.questionable === 1 });
                trackedByWhatsop = true;
              }
            }
          }
          if (arg.type === "data" && arg.expanded && arg.expanded.length > 0) {
            for (const ea of arg.expanded) {
              if (ea.type === "resource" && ea.location) {
                if (/^https?:\/\//i.test(ea.location)) {
                  if (dedupSet.has(ea.location)) continue;
                  dedupSet.add(ea.location);
                  files.push({ absPath: ea.location, type: "resource", external: true, verified: false, questionable: isQuestionable || ea.questionable === 1 });
                  trackedByWhatsop = true;
                } else {
                  const resolved = resolveFileCandidate(ea.location, cwd);
                  if (resolved && !dedupSet.has(resolved.path)) {
                    dedupSet.add(resolved.path);
                    files.push({ absPath: resolved.path, type: "file", external: isExternalPath(resolved.path, cwd), verified: resolved.verified || existsSync(resolved.path), questionable: isQuestionable || ea.questionable === 1 });
                    trackedByWhatsop = true;
                  }
                }
              }
            }
          }
        }
      }
    };

    // ── Try whatsop-based tracking ────────────────────────────────────────
    try {
      const normalize = await _loadWhatsop();
      if (normalize) {
        // ── Optional cd-context resolution (pop-off layer) ──────────────
        // Try to load the contextualizer. If present, it transforms the
        // command string: consumes `cd` directives, rewrites relative file
        // paths to absolute.  If absent, the command passes through unchanged.
        let commandToNormalize = fullCommand;
        if (origin === "bash") {
          try {
            const ctxModPath = pathToFileURL(join(cwd, "whatsop/contextualizer.js")).href;
            const contextualizer = await import(ctxModPath);
            if (typeof contextualizer?.contextualize === "function") {
              const transformed = contextualizer.contextualize(fullCommand, cwd);
              if (transformed !== fullCommand) {
                commandToNormalize = transformed;
              }
            }
          } catch {
            // contextualizer unavailable — pop-off: just use default path
          }
        }

        const result = await normalize(
          { origin, fullCommand: commandToNormalize },
          { cwd, dataCallback: _dataCallback, fileMemo },
        );
        ingestNormalizeResult(result, origin);
      }
    } catch {
      // whatsop failed; fall through to manual tracking
    }

    // ── Fallback manual tracking ──────────────────────────────────────────
    if (!trackedByWhatsop) {
      if (toolName === "read" && input?.path) {
        const resolved = resolveFileCandidate(input.path, cwd);
        if (resolved && !dedupSet.has(resolved.path)) {
          dedupSet.add(resolved.path);
          files.push({ absPath: resolved.path, type: "file", external: isExternalPath(resolved.path, cwd), verified: resolved.verified, questionable: false });
        }
      } else if (toolName === "bash" && fullCommand) {
        const parts = fullCommand.split("|").map(s => s.trim());
        for (const part of parts) {
          const tokens = part.split(/\s+/);
          const [bin, ...args] = tokens;
          const base = bin.includes("/") ? bin.slice(bin.lastIndexOf("/") + 1) : bin;
          const shouldTrack = READ_COMMANDS.has(base) || QUESTIONABLE_READ_COMMANDS.has(base);
          if (!shouldTrack) continue;
          const isQuestionable = QUESTIONABLE_READ_COMMANDS.has(base);
          for (const arg of args) {
            if (!arg.startsWith("-") && !arg.includes("=")) {
              const p = arg.replace(/^['"]|['"]$/g, "");
              if (/^https?:\/\//i.test(p)) {
                if (dedupSet.has(p)) continue;
                dedupSet.add(p);
                files.push({ absPath: p, type: "resource", external: true, verified: false, questionable: isQuestionable });
              } else {
                const resolved = resolveFileCandidate(p, cwd);
                if (resolved && !dedupSet.has(resolved.path)) {
                  dedupSet.add(resolved.path);
                  files.push({ absPath: resolved.path, type: "file", external: isExternalPath(resolved.path, cwd), verified: resolved.verified, questionable: isQuestionable });
                }
              }
            }
          }
        }
      }
    }

    return files;
  }

  /** Extract a Unix-ms timestamp from a session entry (message or entry-level). */
  function entryTimestamp(entry: any, msg: any): number {
    if (typeof msg?.timestamp === "number") return msg.timestamp;
    if (typeof entry.timestamp === "string") return Date.parse(entry.timestamp);
    return Date.now();
  }

  /**
   * Rebuild commandAuditLog by replaying every successful tool_result / bashExecution
   * entry in the session branch through discoverTrackedFiles().  Only called when
   * the PersistedState had no auditLog field (e.g. past sessions created before the
   * audit feature existed).
   */
  async function reconstructAuditFromSession(entries: any[]): Promise<void> {
    // First pass: collect ToolCall blocks from assistant messages.
    // toolCallId → { toolName, args, timestamp }
    const toolCallMap = new Map<string, { toolName: string; args: Record<string, any>; timestamp: number }>();
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = (entry as any).message;
      if (!msg || msg.role !== "assistant") continue;
      if (!Array.isArray(msg.content)) continue;
      const ts = entryTimestamp(entry, msg);
      for (const block of msg.content) {
        if (block?.type === "toolCall" && block.id) {
          toolCallMap.set(block.id, {
            toolName: block.name || "",
            args: (block.arguments as Record<string, any>) ?? {},
            timestamp: ts,
          });
        }
      }
    }

    // Second pass: process every successful result.
    // Track which toolCallIds we've already handled so BashExecutionMessage
    // entries that duplicate a ToolResultMessage are skipped.
    const handledToolCallIds = new Set<string>();

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = (entry as any).message;
      if (!msg) continue;

      let origin: "bash" | "tool-call" | undefined;
      let fullCommand: string | undefined;
      let toolName: string | undefined;
      let input: Record<string, any> | undefined;
      let timestamp: number;
      let toolCallId: string | undefined;

      if (msg.role === "toolResult" && !msg.isError) {
        const tc = toolCallMap.get(msg.toolCallId);
        if (!tc) continue;
        timestamp = tc.timestamp;
        toolName = msg.toolName || tc.toolName;
        input = tc.args;
        toolCallId = msg.toolCallId;
        if (toolName === "bash") {
          const cmd = typeof tc.args.command === "string" ? tc.args.command : "";
          origin = "bash";
          fullCommand = cmd;
        } else {
          origin = "tool-call";
          fullCommand = `${toolName} ${JSON.stringify(input)}`;
        }
        handledToolCallIds.add(toolCallId);
      } else if (msg.role === "bashExecution" && !msg.cancelled) {
        // BashExecutionMessage may duplicate a ToolResultMessage — try to
        // resolve its command back to a ToolCall entry to reuse the ID and
        // skip if already handled.
        const cmd = msg.command || "";
        // Look for a bash ToolCall whose args.command matches this command
        let matched = false;
        for (const [tcId, tc] of toolCallMap) {
          if (tc.toolName === "bash" && tc.args.command === cmd) {
            if (handledToolCallIds.has(tcId)) {
              matched = true; // already handled via ToolResultMessage — skip
            } else {
              // Standalone BashExecutionMessage — use the resolved ToolCall
              origin = "bash";
              fullCommand = cmd;
              toolName = "bash";
              input = { command: cmd };
              timestamp = tc.timestamp;
              toolCallId = tcId;
              handledToolCallIds.add(tcId);
              matched = true;
            }
            break;
          }
        }
        if (matched) {
          // Proceed to record audit below (or skip for already-handled case)
          if (!origin) continue; // was already handled, skip
        } else {
          // No corresponding ToolCall found in the session — process as-is
          origin = "bash";
          fullCommand = cmd;
          toolName = "bash";
          input = { command: cmd };
          timestamp = entryTimestamp(entry, msg);
          // No toolCallId available
        }
      } else {
        continue;
      }

      if (!origin || !fullCommand || !toolName) continue;

      // Replay tracking — pure discovery, no fileMap mutation
      const discovered = await discoverTrackedFiles(origin, fullCommand, toolName, input);
      for (const f of discovered) {
        recordAudit(f.absPath, origin, fullCommand, timestamp, toolCallId);
      }
    }
  }

  // ── Events ───────────────────────────────────────────────────────────────

  pi.on("session_start", async (_evt, ctx) => {
    cwd = ctx.cwd;
    loggingEnabled = pi.getFlag("read-tracker-log") === true;
    await restoreFromSession(ctx);
    await _loadWhatsop();
    updateWidget(ctx);

    const sessionId = ctx.sessionManager.getSessionId();
    if (loggingEnabled && sessionId) {
      sessionLogPath = join(cwd, `${sessionId}.jsonl`);
    } else {
      sessionLogPath = null;
    }
  });

  pi.on("session_tree", async (_evt, ctx) => {
    cwd = ctx.cwd;
    loggingEnabled = pi.getFlag("read-tracker-log") === true;
    await restoreFromSession(ctx);
    await _loadWhatsop();
    updateWidget(ctx);

    const sessionId = ctx.sessionManager.getSessionId();
    if (loggingEnabled && sessionId) {
      sessionLogPath = join(cwd, `${sessionId}.jsonl`);
    } else {
      sessionLogPath = null;
    }
  });

  pi.on("tool_call", async (event) => {
    if (isToolCallEventType("bash", event)) {
      logInvocation("bash", event.input.command || "");
      pendingBashCommands.set(event.toolCallId, event.input.command || "");
      return;
    }
    const input = event.input as Record<string, unknown>;
    const fullCommand = `${event.toolName} ${JSON.stringify(input)}`;
    logInvocation("tool-call", fullCommand);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;

    // ── Gather invocation data ────────────────────────────────────────────
    let origin: "bash" | "tool-call" | undefined;
    let fullCommand: string | undefined;

    if (event.toolName === "bash") {
      const cmd = pendingBashCommands.get(event.toolCallId);
      pendingBashCommands.delete(event.toolCallId);
      if (cmd) {
        origin = "bash";
        fullCommand = cmd;
      }
    } else {
      const input = event.input as Record<string, unknown>;
      origin = "tool-call";
      fullCommand = `${event.toolName} ${JSON.stringify(input)}`;
    }

    if (!fullCommand) return;

    // Use shared discovery logic (whatsop + fallback)
    const discovered = await discoverTrackedFiles(
      origin,
      fullCommand,
      event.toolName,
      event.input as Record<string, any>,
    );

    if (discovered.length > 0) {
      for (const f of discovered) {
        if (f.type === "resource") {
          trackUrlResource(f.absPath, f.questionable, origin, fullCommand, undefined, event.toolCallId);
        } else {
          accumulateRead(f.absPath, f.external, f.verified, f.questionable, origin, fullCommand, undefined, event.toolCallId);
        }
      }
      persistState();
      updateWidget(ctx);
    }
  });

  // ── Commands ─────────────────────────────────────────────────────────────

  pi.registerCommand("read-tracker", {
    description: "Toggle read-files widget  |  args: clear | all | limit <N> | audit",
    handler: async (args, ctx) => {
      const fullInput = (args || "").trim();
      const arg = fullInput.toLowerCase();

      if (arg === "clear") {
        fileMap.clear();
        commandAuditLog.clear();
        persistState();
        updateWidget(ctx);
        ctx.ui.notify("Read tracker: cleared", "info");
        return;
      }

      if (arg === "all") {
        showAll = !showAll;
        persistState();
        updateWidget(ctx);
        ctx.ui.notify(
          showAll
            ? "Read tracker: showing all files"
            : `Read tracker: showing last ${fileLimit} files`,
          "info",
        );
        return;
      }

      if (arg.startsWith("limit ")) {
        const n = parseInt(arg.slice(6), 10);
        if (!isNaN(n) && n > 0) {
          fileLimit = n;
          showAll = false;
          persistState();
          updateWidget(ctx);
          ctx.ui.notify(`Read tracker: limit set to ${n}`, "info");
        } else {
          ctx.ui.notify("Usage: /read-tracker limit <number>", "warning");
        }
        return;
      }

      if (arg === "audit") {
        // Gather tracked files sorted by recency (same order as the widget)
        const files = [...fileMap.values()];
        if (files.length === 0) {
          ctx.ui.notify("No tracked files to audit", "warning");
          return;
        }
        files.sort((a, b) => (b.lastRead ?? 0) - (a.lastRead ?? 0));

        // Present an interactive picker — select() takes string[] only
        const choices = files.map((f, i) => {
          const name = f.type === "resource" ? f.path : basename(f.path);
          const icon = f.type === "resource" ? "🌐" : f.questionable ? "❓" : "📄";
          return `${i + 1}. ${name}  ${icon}  ${f.readCount} read${f.readCount !== 1 ? "s" : ""}`;
        });
        const picked = await ctx.ui.select("Select a file to audit:", choices);
        if (!picked) return; // user cancelled

        // The label starts with "N. " — extract the index from the choice
        const idxMatch = picked.match(/^(\d+)\./);
        const targetFile = idxMatch ? files[parseInt(idxMatch[1], 10) - 1] : undefined;
        if (!targetFile) {
          ctx.ui.notify("Could not resolve selected file", "warning");
          return;
        }

        // ── On-demand audit reconstruction ────────────────────────────────
        // If no audit trail exists (pre-audit sessions), rebuild it now
        // from the session stream so the user gets the full picture.
        if (!_reconstructionInProgress && (commandAuditLog.size === 0 || !commandAuditLog.has(targetFile.path))) {
          _reconstructionInProgress = true;
          ctx.ui.notify(`Reconstructing audit trail…`, "info");
          try {
            commandAuditLog.clear();
            await _loadWhatsop();
            const entries = ctx.sessionManager.getBranch();
            await reconstructAuditFromSession(entries);

            // Reconcile readCount: reads == commands (in case the audit
            // uncovered commands that the persisted fileMap missed).
            for (const fStats of fileMap.values()) {
              const al = commandAuditLog.get(fStats.path);
              if (al) fStats.readCount = al.length;
            }
          } finally {
            _reconstructionInProgress = false;
          }
        }

        // Look up audit entries for this file
        const auditEntries = commandAuditLog.get(targetFile.path) ?? [];
        const label = targetFile.type === "resource" ? targetFile.path : basename(targetFile.path);

        // Build output
        const lines: string[] = [];
        lines.push(`Audit: ${label}`);
        lines.push(`  Path: ${targetFile.path}`);
        lines.push(`  Reads: ${targetFile.readCount}`);
        lines.push("");

        // Most recent first, times right-justified so icons align
        for (const entry of auditEntries.slice().reverse()) {
          const rel = relativeTime(entry.timestamp).padStart(8);
          const icon = entry.origin === "bash" ? "❯" : "$";
          // Short hash displayed in place of full toolCallId (dimmed by renderer)
          const tcDisplay = entry.toolCallId
            ? ` \x01${shortHash(entry.toolCallId, 5)}\x02`
            : "";
          lines.push(`  ${rel}${tcDisplay}  ${icon} ${entry.fullCommand}`);
        }

        // Persist in session stream
        pi.appendEntry("read-tracker-audit", {
          file: targetFile.path,
          label,
          readCount: targetFile.readCount,
          invocations: auditEntries.slice().reverse().map(e => ({
            timestamp: e.timestamp,
            relative: relativeTime(e.timestamp),
            origin: e.origin,
            fullCommand: e.fullCommand,
            toolCallId: e.toolCallId,
          })),
          queriedAt: new Date().toISOString(),
        });

        // Show result
        if (auditEntries.length === 0) {
          ctx.ui.notify(`No recorded commands interacted with "${label}"`, "info");
        } else {
          ctx.ui.notify(`Audit for "${label}" — ${auditEntries.length} invocation(s)`, "info");
          // Display the detailed audit in the conversation
          pi.sendMessage({
            customType: "read-tracker-audit",
            content: lines.join("\n"),
            display: true,
          });
        }
        return;
      }

      widgetEnabled = !widgetEnabled;
      persistState();
      updateWidget(ctx);
      ctx.ui.notify(`Read tracker widget ${widgetEnabled ? "enabled" : "disabled"}`, "info");
    },
  });
}
