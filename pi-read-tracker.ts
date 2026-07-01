
/**
 * Read Tracker Extension
 *
 * Displays a persistent widget above the text input listing every file
 * the agent has read during the current session, along with per-file read counts.
 *
 * Commands:
 *   /read-tracker         – toggle widget visibility
 *   /read-tracker clear   – clear tracked files from current session
 *
 * Placement: ~/.pi/agent/extensions/read-tracker/index.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appendFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";


// ─── Data model ─────────────────────────────────────────────────────────────

interface FileReadStats {
  /** Absolute path to the file */
  path: string;
  /** How many times this file has been read */
  readCount: number;
  /** Whether the file lives outside the current session cwd */
  external: boolean;
  /** Whether the path exists on disk */
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
const READ_COMMANDS = new Set(["cat","grep","less","more","head","tail","sed","awk","sort","wc"]);
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
  // Match ^/c/ or ^\\c\\ where c is a single letter (the Git Bash drive shorthand)
  // and uppercase the drive letter for canonical form.
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
  // Check the basename, not the raw candidate string, so absolute paths like
  // D:\\pi-yum\\confirmed are correctly rejected even though they contain separators.
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
  let widgetEnabled = true;
  let fileLimit = 8;
  let showAll = false;
  let cwd = process.cwd();
  // Capture bash commands for read inference
  const pendingBashCommands = new Map<string, string>();

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
   * Only absolute paths are compressed — relative subdirectory labels are
   * always short enough to fit.
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
            absolutePath: resolved.path,
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
              absolutePath: resolved.path,
              questionable: resolved.verified ? 0 : 1,
            },
          ];
        }
      }
    }
    return [];
  }

  function persistState(): void {
    pi.appendEntry("read-tracker", {
      files: [...fileMap.values()],
      enabled: widgetEnabled,
      fileLimit,
      showAll,
    } satisfies PersistedState);
  }

  function restoreFromSession(ctx: ExtensionContext): void {
    fileMap.clear();
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
      for (const f of lastState.files ?? []) {
        const resolved = resolveFileCandidate(f.path, cwd);
        if (!resolved) continue;
        const normalized: FileReadStats = {
          path: resolved.path,
          readCount: typeof f.readCount === "number" ? f.readCount : 0,
          external: isExternalPath(resolved.path, cwd),
          verified: Boolean(f.verified) || resolved.verified,
          lastRead: typeof f.lastRead === "number" ? f.lastRead : 0,
          questionable: Boolean(f.questionable),
        };
        fileMap.set(normalized.path, normalized);
      }
    }
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
    // Sort entries with the most recently read files first so the widget stays focused on fresh context
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
            const filename = basename(f.path);
            const parentAbs = dirname(f.path);
            const dimSep = theme.fg("dim", " | ");
            const gutterParts: string[] = [];
            if (f.questionable) gutterParts.push("❓");
            if (f.external) gutterParts.push("⚠️");
            const gutter = gutterParts.length ? `${gutterParts.join("")} ` : "   ";
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
            // Match the Edited files pane: no path for direct children,
            // relative subdirectory (e.g. "normops") for nested files,
            // absolute parent only when the file is outside the workspace.
            const pathLabel = isDirectChild
              ? ""
              : f.external
                ? parentAbs
                : parentRelative;
            const fileStr = isVerified
              ? theme.fg("accent", theme.bold(filename))
              : theme.fg("muted", theme.bold(filename));
            const countStr = theme.fg("warning", `📖${f.readCount.toString().padStart(3, " ")}`);

            // Calculate available width for the path and compress if needed
            let pathStr = "";
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

            const leftPart = pathLabel
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

  function accumulateRead(absPath: string, external: boolean, verified: boolean, questionable = false): void {
    const now = Date.now();
    const existing = fileMap.get(absPath);
    if (existing) {
      existing.readCount++;
      existing.external = existing.external || external;
      existing.questionable = existing.questionable || questionable;
      if (verified) {
        existing.verified = true;
      }
      existing.lastRead = now;
    } else {
      fileMap.set(absPath, { path: absPath, readCount: 1, external, verified, lastRead: now, questionable });
    }
  }

  function trackReadCandidate(candidate: string, questionable = false): boolean {
    const resolved = resolveFileCandidate(candidate, cwd);
    if (!resolved) return false;
    const external = isExternalPath(resolved.path, cwd);
    accumulateRead(resolved.path, external, resolved.verified, questionable);
    return true;
  }

  // ── Events ───────────────────────────────────────────────────────────────

  pi.on("session_start", async (_evt, ctx) => {
    cwd = ctx.cwd;
    loggingEnabled = pi.getFlag("read-tracker-log") === true;
    restoreFromSession(ctx);
    await _loadWhatsop();
    updateWidget(ctx);

    // Initialize session log only when the --read-tracker-log flag is active
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
    restoreFromSession(ctx);
    await _loadWhatsop();
    updateWidget(ctx);

    // The session may have changed; refresh the log path
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
    // Log all other tool calls as "tool-call" origin
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

    // ── Try whatsop-based tracking ────────────────────────────────────────
    let tracked = false;

    try {
      const normalize = await _loadWhatsop();
      if (normalize) {
        const result = await normalize(
          { origin, fullCommand },
          { cwd, dataCallback: _dataCallback },
        );

        for (const sub of result.subcommands ?? []) {
          // For tool-call origins, only track the "read" tool
          if (origin === "tool-call" && event.toolName !== "read") continue;
          // For bash origins, only track known read commands
          if (origin === "bash") {
            const actorBase = basename(sub.actor);
            if (!READ_COMMANDS.has(actorBase) && !QUESTIONABLE_READ_COMMANDS.has(actorBase)) continue;
          }

          const isQuestionable =
            origin === "bash" &&
            sub.actor &&
            QUESTIONABLE_READ_COMMANDS.has(basename(sub.actor));

          for (const arg of sub.args ?? []) {
            // Validate resource args through resolveFileCandidate —
            // this rejects bare-word basenames that don't exist on disk
            // even when the path string contains separators (e.g. absolute paths).
            if (arg.type === "resource" && arg.absolutePath) {
              const resolved = resolveFileCandidate(arg.absolutePath, cwd);
              if (resolved) {
                accumulateRead(
                  resolved.path,
                  isExternalPath(resolved.path, cwd),
                  resolved.verified || existsSync(resolved.path),
                  isQuestionable || arg.questionable === 1,
                );
                tracked = true;
              }
            }
            // Also process expanded nodes from dataCallback — these contain
            // resources extracted from structured data payloads (e.g. edit.edits).
            if (arg.type === "data" && arg.expanded && arg.expanded.length > 0) {
              for (const expandedArg of arg.expanded) {
                if (expandedArg.type === "resource" && expandedArg.absolutePath) {
                  const resolved = resolveFileCandidate(expandedArg.absolutePath, cwd);
                  if (resolved) {
                    accumulateRead(
                      resolved.path,
                      isExternalPath(resolved.path, cwd),
                      resolved.verified || existsSync(resolved.path),
                      isQuestionable || expandedArg.questionable === 1,
                    );
                    tracked = true;
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // whatsop failed; fall through to manual tracking
    }

    // ── Fallback manual tracking ──────────────────────────────────────────
    if (!tracked) {
      if (event.toolName === "read") {
        const input = event.input as { path: string };
        if (trackReadCandidate(input.path)) tracked = true;
      } else if (event.toolName === "bash") {
        const parts = fullCommand.split("|").map(s => s.trim());
        for (const part of parts) {
          const [bin, ...args] = part.split(/\s+/);
          const base = bin.includes("/") ? bin.slice(bin.lastIndexOf("/") + 1) : bin;
          const shouldTrack = READ_COMMANDS.has(base) || QUESTIONABLE_READ_COMMANDS.has(base);
          if (!shouldTrack) continue;
          const isQuestionable = QUESTIONABLE_READ_COMMANDS.has(base);
          for (const arg of args) {
            if (!arg.startsWith("-") && !arg.includes("=")) {
              const p = arg.replace(/^['"]|['"]$/g, "");
              if (trackReadCandidate(p, isQuestionable)) tracked = true;
            }
          }
        }
      }
    }

    if (tracked) {
      persistState();
      updateWidget(ctx);
    }
  });

  // ── Commands ─────────────────────────────────────────────────────────────

  pi.registerCommand("read-tracker", {
    description: "Toggle read-files widget  |  args: clear | all | limit <N>",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      if (arg === "clear") {
        fileMap.clear();
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
      widgetEnabled = !widgetEnabled;
      persistState();
      updateWidget(ctx);
      ctx.ui.notify(`Read tracker widget ${widgetEnabled ? "enabled" : "disabled"}`, "info");
    },
  });
}
