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
  /** Host portion (example.com) */
  host: string;
  /** Path/query/hash portion (e.g., /docs/reference#api) */
  path: string;
  /** How many times this resource has been read */
  readCount: number;
  /** Timestamp (ms) of the most recent read */
  lastRead: number;
  /** Whether we consider this source trusted */
  trusted: boolean;
}

const TRUSTED_HOSTS_ENV = "PI_WEB_TRACKER_TRUSTED_HOST_PATTERNS";

interface TrustedPattern {
  raw: string;
  rx: RegExp;
}

interface TrustedPatternParseResult {
  patterns: TrustedPattern[];
  invalid: string[];
  parseError?: string;
}

function parseTrustedHostPatterns(value: string | undefined): TrustedPatternParseResult {
  if (!value) return { patterns: [], invalid: [] };

  const trimmed = value.trim();
  let rawPatterns: string[] = [];

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        return {
          patterns: [],
          invalid: [],
          parseError: `expected a JSON array in ${TRUSTED_HOSTS_ENV}`,
        };
      }
      rawPatterns = parsed
        .filter((entry): entry is string => typeof entry === "string")
        .map(entry => entry.trim())
        .filter(Boolean);
    } catch {
      return {
        patterns: [],
        invalid: [],
        parseError: `invalid JSON in ${TRUSTED_HOSTS_ENV}`,
      };
    }
  } else {
    // Backward-compatible fallback for older comma-separated values.
    rawPatterns = trimmed.split(",").map(part => part.trim()).filter(Boolean);
  }

  const dedupedRawPatterns = [...new Set(rawPatterns)];
  const patterns: TrustedPattern[] = [];
  const invalid: string[] = [];

  for (const raw of dedupedRawPatterns) {
    try {
      patterns.push({ raw, rx: new RegExp(raw, "i") });
    } catch {
      invalid.push(raw);
    }
  }

  return { patterns, invalid };
}

function isTrustedUrl(url: string, host: string, trustedHostPatterns: TrustedPattern[]): boolean {
  if (trustedHostPatterns.length === 0) return false;
  return trustedHostPatterns.some(({ rx }) => rx.test(url) || (!!host && rx.test(host)));
}

interface PersistedState {
  resources: NetworkReadStats[];
  enabled: boolean;
  fileLimit?: number;
  showAll?: boolean;
}

const DEFAULT_LIMIT = 8;
const URL_IN_COMMAND_RX = /\bhttps?:\/\/[^\s"'`<>]+/gi;

function extractHttpUrls(text: string): string[] {
  const matches = text.match(URL_IN_COMMAND_RX) ?? [];
  const deduped = new Set<string>();
  for (const raw of matches) {
    const cleaned = raw
      .replace(/^[\("'`<\[]+/, "")
      .replace(/[\)\]}'",.;!?]+$/, "");
    if (cleaned) deduped.add(cleaned);
  }
  return [...deduped];
}

function resolveNetworkResource(
  candidate: string,
  trustedHostPatterns: TrustedPattern[],
): { url: string; domain: string; host: string; path: string; trusted: boolean } | undefined {
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
  const host = parsed.host;
  const pathname = parsed.pathname || "/";
  const query = parsed.search || "";
  const hash = parsed.hash || "";
  const path = `${pathname}${query}${hash}`;
  const canonicalUrl = parsed.toString();
  return {
    url: canonicalUrl,
    domain,
    host,
    path: path === "" ? "/" : path,
    trusted: isTrustedUrl(canonicalUrl, host, trustedHostPatterns),
  };
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function webTracker(pi: ExtensionAPI): void {
  const resourceMap = new Map<string, NetworkReadStats>();
  const pendingWebfetchUrls = new Map<string, string>();
  const pendingBashCommands = new Map<string, string>();
  const {
    patterns: trustedHostPatterns,
    invalid: invalidTrustedHostPatterns,
    parseError: trustedHostPatternParseError,
  } = parseTrustedHostPatterns(process.env[TRUSTED_HOSTS_ENV]);
  let trustConfigNoticeShown = false;
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
      const url = resource.url;
      if (!url) continue;
      let parsed: URL | undefined;
      try {
        parsed = new URL(url);
      } catch {
        parsed = undefined;
      }
      const host = resource.host || parsed?.host || "";
      const domain = resource.domain || (parsed ? parsed.origin : "");
      const normalized: NetworkReadStats = {
        url,
        domain,
        host,
        path: resource.path ?? "/",
        readCount: typeof resource.readCount === "number" ? resource.readCount : 0,
        lastRead: typeof resource.lastRead === "number" ? resource.lastRead : 0,
        trusted: isTrustedUrl(url, host, trustedHostPatterns),
      };
      resourceMap.set(url, normalized);
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
            const warningSlot = resource.trusted ? "  " : theme.fg("error", "⚠️");
            const globeSlot = "🌐";
            const gutter = `${warningSlot}${globeSlot} `;
            const pathStr = theme.fg("accent", theme.bold(pathLabel));
            const domainStr = resource.trusted
              ? theme.fg("dim", resource.domain)
              : theme.fg("warning", resource.domain);
            const leftPart = `${gutter}${dimSep}${pathStr}${dimSep}${domainStr}`;
            const countStr = theme.fg("warning", `📖${resource.readCount.toString().padStart(3, " ")}`);
            const gap = Math.max(1, width - visibleWidth(leftPart) - visibleWidth(countStr));
            lines.push(truncateToWidth(`${leftPart}${" ".repeat(gap)}${countStr}`, width));
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

  function accumulate(resource: { url: string; domain: string; host: string; path: string; trusted: boolean }): void {
    const now = Date.now();
    const existing = resourceMap.get(resource.url);
    if (existing) {
      existing.readCount++;
      existing.lastRead = now;
      existing.domain = resource.domain;
      existing.host = resource.host;
      existing.trusted = resource.trusted;
    } else {
      resourceMap.set(resource.url, {
        url: resource.url,
        domain: resource.domain,
        host: resource.host,
        path: resource.path || "/",
        readCount: 1,
        lastRead: now,
        trusted: resource.trusted,
      });
    }
  }

  pi.on("session_start", (_evt, ctx) => {
    restoreFromSession(ctx);
    updateWidget(ctx);
    if (trustConfigNoticeShown || !ctx.hasUI) return;
    trustConfigNoticeShown = true;
    if (trustedHostPatternParseError) {
      ctx.ui.notify(`Web tracker: ${trustedHostPatternParseError}`, "warning");
    }
    if (invalidTrustedHostPatterns.length > 0) {
      ctx.ui.notify(
        `Web tracker: invalid trusted-host regex ignored: ${invalidTrustedHostPatterns.join(", ")}`,
        "warning",
      );
    }
    if (trustedHostPatterns.length === 0) {
      ctx.ui.notify(
        `Web tracker: no trusted-host regex configured. Set ${TRUSTED_HOSTS_ENV} to a JSON array of regex strings.`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(
      `Web tracker trusted-host regexes: ${trustedHostPatterns.map(pattern => pattern.raw).join(", ")}`,
      "info",
    );
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
      return;
    }

    if (event.toolName === "bash") {
      const input = event.input as { command?: string };
      if (input?.command) {
        pendingBashCommands.set(event.toolCallId, input.command);
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "webfetch") {
      const fallbackUrl = pendingWebfetchUrls.get(event.toolCallId);
      pendingWebfetchUrls.delete(event.toolCallId);
      if (event.isError) return;
      const details = event.details as { finalUrl?: string; url?: string } | undefined;
      const candidateUrl = details?.finalUrl || details?.url || fallbackUrl || (event.input as { url?: string })?.url;
      if (!candidateUrl) return;
      const resolved = resolveNetworkResource(candidateUrl, trustedHostPatterns);
      if (!resolved) return;
      accumulate(resolved);
      persistState();
      updateWidget(ctx);
      return;
    }

    if (event.toolName === "bash") {
      const fallbackCommand = pendingBashCommands.get(event.toolCallId);
      pendingBashCommands.delete(event.toolCallId);
      if (event.isError) return;
      const command = fallbackCommand || (event.input as { command?: string })?.command;
      if (!command) return;
      const urls = extractHttpUrls(command);
      if (urls.length === 0) return;

      let changed = false;
      for (const candidateUrl of urls) {
        const resolved = resolveNetworkResource(candidateUrl, trustedHostPatterns);
        if (!resolved) continue;
        accumulate(resolved);
        changed = true;
      }

      if (!changed) return;
      persistState();
      updateWidget(ctx);
      return;
    }

    if (event.isError || event.toolName !== "read") return;
    const input = event.input as { path?: string };
    if (!input?.path) return;
    const resolved = resolveNetworkResource(input.path, trustedHostPatterns);
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
