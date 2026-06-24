
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
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { existsSync } from "node:fs";


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

function composePathTransforms(...steps: PathTransform[]): PathTransform {
  return (value, cwd) => steps.reduce((result, step) => step(result, cwd), value);
}

const toCanonicalAbsPath = composePathTransforms(
  normalizeSlashes,
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
            const parentRelative = normalizeSlashes(relative(cwdSnap, parentAbs));
            const isDirectChild = parentAbs === cwdSnap;
            // When the file lives below the cwd, show a relative subpath like "./wip";
            // external files keep the absolute path so you can tell where they came from.
            const pathLabel = f.external
              ? parentAbs
              : isDirectChild
                ? ""
                : `./${parentRelative || "."}`;
            const fileStr = isVerified
              ? theme.fg("accent", theme.bold(filename))
              : theme.fg("muted", theme.bold(filename));
            const pathStr = pathLabel
              ? f.external
                ? theme.fg("dim", pathLabel)
                : isVerified
                  ? theme.fg("text", pathLabel)
                  : theme.fg("border", pathLabel)
              : "";

            const leftPart = pathLabel
              ? `${gutter}${dimSep}${fileStr}${dimSep}${pathStr}`
              : `${gutter}${dimSep}${fileStr}`;

            const countStr = theme.fg("warning", `📖${f.readCount.toString().padStart(3, " ")}`);
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
    restoreFromSession(ctx);
    updateWidget(ctx);
  });

  pi.on("session_tree", async (_evt, ctx) => {
    cwd = ctx.cwd;
    restoreFromSession(ctx);
    updateWidget(ctx);
  });

  pi.on("tool_call", async (event) => {
    if (isToolCallEventType("bash", event)) {
      pendingBashCommands.set(event.toolCallId, event.input.command || "");
      return;
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;

    // explicit read-tool calls
    if (event.toolName === "read") {
      const input = event.input as { path: string };
      if (trackReadCandidate(input.path)) {
        persistState();
        updateWidget(ctx);
      }
      return;
    }

    // infer reads from bash commands
    if (event.toolName === "bash") {
      const cmd = pendingBashCommands.get(event.toolCallId) || "";
      pendingBashCommands.delete(event.toolCallId);
      const parts = cmd.split("|").map(s => s.trim());
      let tracked = false;
      for (const part of parts) {
        const [bin, ...args] = part.split(/\s+/);
        const base = bin.includes("/") ? bin.slice(bin.lastIndexOf("/") + 1) : bin;
        const shouldTrack = READ_COMMANDS.has(base) || QUESTIONABLE_READ_COMMANDS.has(base);
        if (!shouldTrack) continue;
        const isQuestionable = QUESTIONABLE_READ_COMMANDS.has(base);
        for (const arg of args) {
          if (!arg.startsWith("-") && !arg.includes("=")) {
            const p = arg.replace(/^['"]|['"]$/g, "");
            if (trackReadCandidate(p, isQuestionable)) {
              tracked = true;
            }
          }
        }
      }
      if (tracked) {
        persistState();
        updateWidget(ctx);
      }
      return;
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
