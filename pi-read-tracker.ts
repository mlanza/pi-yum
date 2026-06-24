
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
import { basename, dirname, isAbsolute, resolve } from "node:path";

// ─── Data model ─────────────────────────────────────────────────────────────

interface FileReadStats {
  /** Absolute path to the file */
  path: string;
  /** How many times this file has been read */
  readCount: number;
}

interface PersistedState {
  files: FileReadStats[];
  enabled: boolean;
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function toRelativePath(absPath: string, cwd: string): string {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

function toAbsPath(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function readTracker(pi: ExtensionAPI): void {
  const fileMap = new Map<string, FileReadStats>();
  let widgetEnabled = true;
  let cwd = process.cwd();
  // Capture bash commands for read inference
  const pendingBashCommands = new Map<string, string>();

  function persistState(): void {
    pi.appendEntry("read-tracker", {
      files: [...fileMap.values()],
      enabled: widgetEnabled,
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
      for (const f of lastState.files ?? []) {
        fileMap.set(f.path, f);
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

    const snapshot = [...files];
    const cwdSnap = cwd;

    ctx.ui.setWidget("read-tracker", (_tui, theme) => {
      let cachedLines: string[] | undefined;
      let cachedWidth: number | undefined;

      return {
        render(width: number): string[] {
          if (cachedLines && cachedWidth === width) return cachedLines;
          const lines: string[] = [];

          // Header
          const title = ` Read files (${snapshot.length}) `;
          const titleColored = theme.fg("accent", title);
          const borderLen = Math.max(0, width - visibleWidth(title));
          const borderLeft = theme.fg("borderMuted", "─".repeat(2));
          const borderRight = theme.fg("borderMuted", "─".repeat(Math.max(0, borderLen - 2)));
          lines.push(truncateToWidth(`${borderLeft}${titleColored}${borderRight}`, width));

          // File rows
          for (const f of snapshot) {
            const rel = toRelativePath(f.path, cwdSnap);
            const filename = basename(rel);
            const parent = dirname(rel);
            const dimSep = theme.fg("dim", " | ");
            const icon = "   ";
            const fileStr = theme.fg("accent", theme.bold(filename));
            const parentStr = theme.fg("dim", parent);

            const leftPart = parent === "."
              ? `${icon}${dimSep}${fileStr}`
              : `${icon}${dimSep}${fileStr}${dimSep}${parentStr}`;

            const countStr = theme.fg("warning", `📖${f.readCount}`);
            const gap = Math.max(1, width - visibleWidth(leftPart) - visibleWidth(countStr));
            lines.push(truncateToWidth(`${leftPart}${" ".repeat(gap)}${countStr}`, width));
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

  function accumulateRead(absPath: string): void {
    const existing = fileMap.get(absPath);
    if (existing) {
      existing.readCount++;
    } else {
      fileMap.set(absPath, { path: absPath, readCount: 1 });
    }
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
      const abs = toAbsPath(input.path, cwd);
      accumulateRead(abs);
      persistState();
      updateWidget(ctx);
      return;
    }

    // infer reads from bash commands
    if (event.toolName === "bash") {
      const cmd = pendingBashCommands.get(event.toolCallId) || "";
      pendingBashCommands.delete(event.toolCallId);
      const parts = cmd.split("|").map(s => s.trim());
      const readCmds = new Set(["cat","grep","less","more","head","tail","sed","awk","sort","wc"]);
      for (const part of parts) {
        const [bin, ...args] = part.split(/\s+/);
        const base = bin.includes("/") ? bin.slice(bin.lastIndexOf("/") + 1) : bin;
        if (readCmds.has(base)) {
          for (const arg of args) {
            if (!arg.startsWith("-") && !arg.includes("=")) {
              const p = arg.replace(/^['"]|['"]$/g, "");
              try {
                const abs = toAbsPath(p, cwd);
                accumulateRead(abs);
              } catch {
                /* ignore invalid paths */
              }
            }
          }
        }
      }
      if (pendingBashCommands.has(event.toolCallId)) {
        pendingBashCommands.delete(event.toolCallId);
      }
      persistState();
      updateWidget(ctx);
      return;
    }
  });

  // ── Commands ─────────────────────────────────────────────────────────────

  pi.registerCommand("read-tracker", {
    description: "Toggle read-files widget  |  args: clear",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      if (arg === "clear") {
        fileMap.clear();
        persistState();
        updateWidget(ctx);
        ctx.ui.notify("Read tracker: cleared", "info");
        return;
      }
      widgetEnabled = !widgetEnabled;
      persistState();
      updateWidget(ctx);
      ctx.ui.notify(`Read tracker widget ${widgetEnabled ? "enabled" : "disabled"}`, "info");
    },
  });
}
