/**
 * Web Tracker Extension
 *
 * Displays a persistent widget above the text input listing every network
 * resource the agent has read during the current session, along with per-url
 * read counts. The widget mirrors the look of the read-files tracker while
 * recognizing URLs as their own domain/path pairs.
 *
 * Commands:
 *   /web-tracker         – toggle widget visibility
 *   /web-tracker clear   – clear tracked network reads from current session
 *   /web-tracker all     – toggle show-all mode for the network list
 *   /web-tracker limit N – set the visible-resource cap (default: 8)
 *
 * Placement: ~/.pi/agent/extensions/web-tracker/index.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ─── Data model ─────────────────────────────────────────────────────────────

interface NetworkReadStats {
  /** Canonical URL string */
  url: string;
  /** Domain + scheme (https://example.com) */
  domain: string;
  /** Path/query/hash portion (e.g., /docs/reference#api) */
  path: string;
  /** How many times this resource has been read */
  readCount: number;
  /** Timestamp (ms) of the most recent read */
  lastRead: number;
}

interface PersistedState {
  resources: NetworkReadStats[];
  enabled: boolean;
  fileLimit?: number;
  showAll?: boolean;
}

const DEFAULT_LIMIT = 8;

function resolveNetworkResource(candidate: string): { url: string; domain: string; path: string } | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  const domain = `${parsed.protocol}//${parsed.host}`;
  const pathname = parsed.pathname || "/";
  const query = parsed.search || "";
  const hash = parsed.hash || "";
  const path = `${pathname}${query}${hash}`;
  return { url: parsed.toString(), domain, path: path === "" ? "/" : path };
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function webTracker(pi: ExtensionAPI): void {
  const resourceMap = new Map<string, NetworkReadStats>();
  const pendingWebfetchUrls = new Map<string, string>();
  let widgetEnabled = true;
  let fileLimit = DEFAULT_LIMIT;
  let showAll = false;

  function persistState(): void {
    pi.appendEntry("web-tracker", {
      resources: [...resourceMap.values()],
      enabled: widgetEnabled,
      fileLimit,
      showAll,
    } satisfies PersistedState);
  }

  function restoreFromSession(ctx: ExtensionContext): void {
    resourceMap.clear();
    const entries = ctx.sessionManager.getBranch();
    let lastState: PersistedState | undefined;
    for (const entry of entries) {
      if (entry.type === "custom" && (entry as any).customType === "web-tracker") {
        lastState = (entry as any).data;
      }
    }
    if (!lastState) return;
    widgetEnabled = lastState.enabled ?? true;
    fileLimit = lastState.fileLimit ?? DEFAULT_LIMIT;
    showAll = lastState.showAll ?? false;
    for (const resource of lastState.resources ?? []) {
      resourceMap.set(resource.url, resource);
    }
  }

  function updateWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const resources = [...resourceMap.values()];
    if (!widgetEnabled || resources.length === 0) {
      ctx.ui.setWidget("web-tracker", undefined);
      return;
    }

    const sorted = [...resources];
    sorted.sort((a, b) => (b.lastRead ?? 0) - (a.lastRead ?? 0));

    const totalCount = sorted.length;
    const limitCap = Math.max(1, fileLimit);
    const displayCount = showAll ? totalCount : Math.min(limitCap, totalCount);
    const hiddenCount = totalCount - displayCount;
    const visibleResources = sorted.slice(0, displayCount);

    ctx.ui.setWidget("web-tracker", (_tui, theme) => {
      let cachedLines: string[] | undefined;
      let cachedWidth: number | undefined;

      return {
        render(width: number): string[] {
          if (cachedLines && cachedWidth === width) return cachedLines;
          const lines: string[] = [];

          const title = hiddenCount === 0
            ? ` Read resources (${totalCount}) `
            : ` Read resources (${displayCount}/${totalCount}) `;
          const titleColored = theme.fg("accent", title);
          const borderLen = Math.max(0, width - visibleWidth(title));
          const borderLeft = theme.fg("borderMuted", "─".repeat(2));
          const borderRight = theme.fg("borderMuted", "─".repeat(Math.max(0, borderLen - 2)));
          lines.push(truncateToWidth(`${borderLeft}${titleColored}${borderRight}`, width));

          const dimSep = theme.fg("dim", " | ");
          for (const resource of visibleResources) {
            const pathLabel = resource.path || "/";
            const leftPart = `${"🌐 "}${dimSep}${theme.fg("accent", theme.bold(pathLabel))}`;
            const domainStr = theme.fg("dim", resource.domain);
            const leftWithDomain = `${leftPart}${dimSep}${domainStr}`;
            const countStr = theme.fg("warning", `📖${resource.readCount.toString().padStart(3, " ")}`);
            const gap = Math.max(1, width - visibleWidth(leftWithDomain) - visibleWidth(countStr));
            lines.push(truncateToWidth(`${leftWithDomain}${" ".repeat(gap)}${countStr}`, width));
          }

          if (hiddenCount > 0) {
            const moreMsg = ` … ${hiddenCount} older resource${hiddenCount !== 1 ? "s" : ""} hidden · /web-tracker all`;
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

  function accumulate(resource: { url: string; domain: string; path: string }): void {
    const now = Date.now();
    const existing = resourceMap.get(resource.url);
    if (existing) {
      existing.readCount++;
      existing.lastRead = now;
    } else {
      resourceMap.set(resource.url, {
        url: resource.url,
        domain: resource.domain,
        path: resource.path || "/",
        readCount: 1,
        lastRead: now,
      });
    }
  }

  pi.on("session_start", (_evt, ctx) => {
    restoreFromSession(ctx);
    updateWidget(ctx);
  });

  pi.on("session_tree", (_evt, ctx) => {
    restoreFromSession(ctx);
    updateWidget(ctx);
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "webfetch") {
      const input = event.input as { url?: string };
      if (input?.url) {
        pendingWebfetchUrls.set(event.toolCallId, input.url);
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;

    if (event.toolName === "webfetch") {
      const fallbackUrl = pendingWebfetchUrls.get(event.toolCallId);
      pendingWebfetchUrls.delete(event.toolCallId);
      const details = event.details as { finalUrl?: string; url?: string } | undefined;
      const candidateUrl = details?.finalUrl || details?.url || fallbackUrl || (event.input as { url?: string })?.url;
      if (!candidateUrl) return;
      const resolved = resolveNetworkResource(candidateUrl);
      if (!resolved) return;
      accumulate(resolved);
      persistState();
      updateWidget(ctx);
      return;
    }

    if (event.toolName !== "read") return;
    const input = event.input as { path?: string };
    if (!input?.path) return;
    const resolved = resolveNetworkResource(input.path);
    if (!resolved) return;
    accumulate(resolved);
    persistState();
    updateWidget(ctx);
  });

  pi.registerCommand("web-tracker", {
    description: "Toggle network-resource widget  |  args: clear | all | limit <N>",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      if (arg === "clear") {
        resourceMap.clear();
        persistState();
        updateWidget(ctx);
        ctx.ui.notify("Web tracker: cleared", "info");
        return;
      }
      if (arg === "all") {
        showAll = !showAll;
        persistState();
        updateWidget(ctx);
        ctx.ui.notify(
          showAll
            ? "Web tracker: showing all resources"
            : `Web tracker: showing last ${fileLimit} resources`,
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
          ctx.ui.notify(`Web tracker: limit set to ${n}`, "info");
        } else {
          ctx.ui.notify("Usage: /web-tracker limit <number>", "warning");
        }
        return;
      }
      widgetEnabled = !widgetEnabled;
      persistState();
      updateWidget(ctx);
      ctx.ui.notify(`Web tracker widget ${widgetEnabled ? "enabled" : "disabled"}`, "info");
    },
  });
}
