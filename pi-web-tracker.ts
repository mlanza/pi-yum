/**
 * Web Tracker Extension
 *
 * Displays a persistent widget above the text input listing every network
 * resource the agent has read during the current session, along with per-url
 * read counts. The widget mirrors the look of the read-files tracker while
 * recognizing URLs as their own domain/path pairs.
 *
 * Commands:
 *   /web-tracker           – toggle widget visibility
 *   /web-tracker clear     – clear tracked network reads from current session
 *   /web-tracker all       – toggle show-all mode for the network list
 *   /web-tracker limit N   – set the visible-resource cap (default: 7)
 *   /web-approval ask|approve|deny – set untrusted URL handling mode
 *   /web-approval status           – show current approval mode
 *   /web-approval list             – list trusted URL regex patterns
 *   /web-render old|new            – switch URL rendering layout
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
const WEB_APPROVAL_MODE_ENV = "PI_WEB_TRACKER_APPROVAL_MODE";

interface TrustedPattern {
  raw: string;
  rx: RegExp;
}

interface TrustedPatternParseResult {
  patterns: TrustedPattern[];
  invalid: string[];
  parseError?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveRootHost(hostname: string): string {
  const host = hostname.trim().toLowerCase();
  if (!host) return host;
  if (host === "localhost") return host;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  return host.replace(/^www\./, "");
}

function buildSessionTrustPatternFromUrl(candidateUrl: string): {
  labelUrl: string;
  rawRegex: string;
} | undefined {
  let parsed: URL;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    return undefined;
  }

  const rootHost = deriveRootHost(parsed.hostname);
  if (!rootHost) return undefined;

  const labelUrl = `${parsed.protocol}//${rootHost}`;
  const escapedRoot = escapeRegExp(rootHost);
  const rawRegex = `^https?:\\/\\/(?:[^\\/]+\\.)*${escapedRoot}(?::\\d+)?(?:\\/|$)`;
  return { labelUrl, rawRegex };
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

type WebApprovalMode = "ask" | "approve" | "deny";

function parseWebApprovalMode(value: string | undefined): WebApprovalMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "ask" || normalized === "approve" || normalized === "deny") {
    return normalized;
  }
  return undefined;
}

interface PersistedState {
  resources: NetworkReadStats[];
  enabled: boolean;
  fileLimit?: number;
  showAll?: boolean;
  webApprovalMode?: WebApprovalMode;
  webRenderLayout?: UrlLayout;
  sessionTrustedHostPatterns?: string[];
}

interface ApprovalDecision {
  allow: boolean;
  reason?: string;
  terminate?: boolean;
}

const DEFAULT_LIMIT = 7;
const URL_IN_COMMAND_RX = /\bhttps?:\/\/[^\s"'`<>]+/gi;

type UrlLayout = "old" | "new";
const DEFAULT_URL_LAYOUT: UrlLayout = "new";

type UrlPortionRenderer = (
  resource: NetworkReadStats,
  theme: {
    fg: (slot: string, text: string) => string;
    bold: (text: string) => string;
  },
  parts: {
    gutter: string;
    dimSep: string;
  },
) => string;

const renderUrlPortionOld: UrlPortionRenderer = (resource, theme, { gutter, dimSep }) => {
  const pathLabel = resource.path || "/";
  const pathStr = theme.fg("accent", theme.bold(pathLabel));
  const domainStr = theme.fg("dim", resource.domain);
  return `${gutter}${dimSep}${pathStr}${dimSep}${domainStr}`;
};

const renderUrlPortionNew: UrlPortionRenderer = (resource, theme, { gutter }) => {
  const pathLabel = resource.path || "/";
  const pathStr = theme.fg("accent", theme.bold(pathLabel));
  const domainStr = theme.fg("dim", resource.domain);
  return `${gutter}${domainStr}${pathStr}`;
};

function makeUrlPortionRenderer(currentLayout: UrlLayout): UrlPortionRenderer {
  return currentLayout === "old" ? renderUrlPortionOld : renderUrlPortionNew;
}

type CanonicalToolName = "web_fetch" | "open_links" | "bash" | "read" | "other";

function canonicalizeToolName(toolName: string): CanonicalToolName {
  const raw = (toolName || "").trim().toLowerCase();
  const stripped = raw.startsWith("functions.") ? raw.slice("functions.".length) : raw;

  if (stripped === "web_fetch" || stripped === "webfetch") return "web_fetch";
  if (stripped === "open_links") return "open_links";
  if (stripped === "bash") return "bash";
  if (stripped === "read") return "read";
  return "other";
}

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

function collectStringLeaves(value: unknown, out: Set<string>, seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    out.add(value);
    return;
  }

  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) collectStringLeaves(entry, out, seen);
    return;
  }

  const record = value as Record<string, unknown>;
  for (const entry of Object.values(record)) {
    collectStringLeaves(entry, out, seen);
  }
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
  const trustedHostParseResult = parseTrustedHostPatterns(process.env[TRUSTED_HOSTS_ENV]);
  const trustedHostPatterns = [...trustedHostParseResult.patterns];
  const sessionTrustedHostPatterns: string[] = [];
  const invalidTrustedHostPatterns = trustedHostParseResult.invalid;
  const trustedHostPatternParseError = trustedHostParseResult.parseError;
  const envWebApprovalModeRaw = process.env[WEB_APPROVAL_MODE_ENV];
  const envWebApprovalModeParsed = parseWebApprovalMode(envWebApprovalModeRaw);
  const defaultWebApprovalMode: WebApprovalMode = envWebApprovalModeParsed ?? "deny";
  const webApprovalModeEnvInvalid = !!envWebApprovalModeRaw && !envWebApprovalModeParsed;

  let trustConfigNoticeShown = false;
  let widgetEnabled = true;
  let fileLimit = DEFAULT_LIMIT;
  let showAll = false;
  let webApprovalMode: WebApprovalMode = defaultWebApprovalMode;
  let webRenderLayout: UrlLayout = DEFAULT_URL_LAYOUT;

  function persistState(): void {
    pi.appendEntry("web-tracker", {
      resources: [...resourceMap.values()],
      enabled: widgetEnabled,
      fileLimit,
      showAll,
      webApprovalMode,
      webRenderLayout,
      sessionTrustedHostPatterns: [...sessionTrustedHostPatterns],
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
    // Backward compatibility: prior "off" maps to "approve".
    const persistedMode = (lastState as PersistedState & { webApprovalMode?: string }).webApprovalMode;
    webApprovalMode = persistedMode === "ask"
      ? "ask"
      : persistedMode === "approve"
        ? "approve"
        : persistedMode === "deny"
          ? "deny"
          : persistedMode === "off"
            ? "approve"
            : defaultWebApprovalMode;
    const persistedLayout = lastState.webRenderLayout;
    webRenderLayout = persistedLayout === "old" || persistedLayout === "new"
      ? persistedLayout
      : DEFAULT_URL_LAYOUT;

    sessionTrustedHostPatterns.length = 0;
    const persistedSessionPatterns = Array.isArray(lastState.sessionTrustedHostPatterns)
      ? lastState.sessionTrustedHostPatterns
      : [];
    const invalidSessionPatterns: string[] = [];
    for (const rawPattern of persistedSessionPatterns) {
      if (typeof rawPattern !== "string" || !rawPattern.trim()) continue;
      const raw = rawPattern.trim();
      try {
        const rx = new RegExp(raw, "i");
        const alreadyPresent = trustedHostPatterns.some(pattern => pattern.raw === raw);
        if (!alreadyPresent) trustedHostPatterns.push({ raw, rx });
        if (!sessionTrustedHostPatterns.includes(raw)) sessionTrustedHostPatterns.push(raw);
      } catch {
        invalidSessionPatterns.push(raw);
      }
    }
    if (invalidSessionPatterns.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `Web tracker: invalid persisted trusted-host regex ignored: ${invalidSessionPatterns.join(", ")}`,
        "warning",
      );
    }

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
          const renderUrlPortion = makeUrlPortionRenderer(webRenderLayout);
          for (const resource of visibleResources) {
            const warningSlot = resource.trusted ? "  " : theme.fg("error", "⚠️");
            const globeSlot = "🌐";
            const gutter = `${warningSlot}${globeSlot} `;
            const leftPart = renderUrlPortion(resource, theme, { gutter, dimSep });
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

  function formatToolCall(toolName: string, input: unknown): string {
    const args = (() => {
      try {
        return JSON.stringify(input ?? {}, null, 2) || "{}";
      } catch {
        return "{}";
      }
    })();
    return `${toolName}(${args})`;
  }

  function extractUrlsFromToolCall(toolName: string, input: unknown): string[] {
    const canonicalTool = canonicalizeToolName(toolName);
    const discovered = new Set<string>();

    if (canonicalTool === "web_fetch") {
      const url = (input as { url?: unknown })?.url;
      if (typeof url === "string") discovered.add(url);
    }

    if (canonicalTool === "open_links") {
      const urls = (input as { urls?: unknown })?.urls;
      if (Array.isArray(urls)) {
        for (const url of urls) {
          if (typeof url === "string") discovered.add(url);
        }
      }
    }

    if (canonicalTool === "bash") {
      const command = (input as { command?: unknown })?.command;
      if (typeof command === "string") {
        for (const url of extractHttpUrls(command)) discovered.add(url);
      }
    }

    if (canonicalTool === "read") {
      const path = (input as { path?: unknown })?.path;
      if (typeof path === "string") discovered.add(path);
    }

    // Generic fallback: inspect all string args for every tool call.
    // This keeps approval coverage for newly-installed URL-bearing tools.
    const stringLeaves = new Set<string>();
    collectStringLeaves(input, stringLeaves);
    for (const leaf of stringLeaves) {
      for (const url of extractHttpUrls(leaf)) {
        discovered.add(url);
      }
    }

    return [...discovered];
  }

  async function requestWebApproval(
    toolName: string,
    input: unknown,
    urls: string[],
    ctx: ExtensionContext,
  ): Promise<ApprovalDecision> {
    if (urls.length === 0) return { allow: true };

    if (ctx.hasUI) {
      ctx.ui.notify(
        `Web tracker: untrusted URL call detected (${toolName})`,
        "warning",
      );
    }

    if (webApprovalMode === "approve") {
      return { allow: true };
    }

    if (webApprovalMode === "deny") {
      return {
        allow: false,
        reason: "Blocked web call: /web-approval deny mode",
      };
    }

    if (!ctx.hasUI) {
      return {
        allow: false,
        reason: "Blocked web call: /web-approval ask mode requires interactive UI.",
      };
    }

    const invocation = formatToolCall(toolName, input);
    const urlList = urls.map(url => `  • ${url}`).join("\n");

    const addableTrust = buildSessionTrustPatternFromUrl(urls[0] ?? "");

    const message = [
      "Untrusted URL(s) detected:",
      urls.length > 0 ? urlList : "  • (none)",
      "",
      "Full tool invocation:",
      invocation,
      "",
      addableTrust
        ? `Choose Yes to allow, No to block, or Trust (${addableTrust.labelUrl}) for this session.`
        : "Choose Yes to allow or No to block.",
    ].join("\n");

    const addChoice = addableTrust ? `Trust (${addableTrust.labelUrl})` : undefined;
    const choices = addChoice ? ["Yes", "No", addChoice] : ["Yes", "No"];
    const picked = await ctx.ui.select(`🌐 Web tracker · Approve call?\n\n${message}`, choices);

    if (picked === "Yes") return { allow: true };

    if (addChoice && picked === addChoice && addableTrust) {
      const alreadyTrusted = trustedHostPatterns.some(pattern => {
        try {
          return pattern.rx.test(addableTrust.labelUrl) || pattern.rx.test(new URL(addableTrust.labelUrl).host);
        } catch {
          return false;
        }
      });
      if (!alreadyTrusted) {
        trustedHostPatterns.push({ raw: addableTrust.rawRegex, rx: new RegExp(addableTrust.rawRegex, "i") });
      }
      if (!sessionTrustedHostPatterns.includes(addableTrust.rawRegex)) {
        sessionTrustedHostPatterns.push(addableTrust.rawRegex);
      }

      // Refresh trust badges for existing tracked resources immediately.
      for (const resource of resourceMap.values()) {
        resource.trusted = isTrustedUrl(resource.url, resource.host, trustedHostPatterns);
      }
      persistState();
      updateWidget(ctx);

      ctx.ui.notify(`Web tracker: trusted for this session: ${addableTrust.labelUrl}`, "info");
      return { allow: true };
    }

    return {
      allow: false,
      reason: "Blocked web call by user.",
      terminate: true,
    };
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
    if (webApprovalModeEnvInvalid) {
      ctx.ui.notify(
        `Web tracker: invalid ${WEB_APPROVAL_MODE_ENV} value \"${envWebApprovalModeRaw}\"; using ${defaultWebApprovalMode}`,
        "warning",
      );
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
      `Web tracker trusted-host regexes: ${trustedHostPatterns.map(pattern => pattern.raw).join(", ")}; Web approval: ${webApprovalMode}`,
      "info",
    );
  });

  pi.on("session_tree", (_evt, ctx) => {
    restoreFromSession(ctx);
    updateWidget(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    const resolvedCandidates = extractUrlsFromToolCall(event.toolName, event.input)
      .map(url => resolveNetworkResource(url, trustedHostPatterns))
      .filter((resource): resource is NonNullable<typeof resource> => Boolean(resource));

    const untrustedUrls = [...new Set(
      resolvedCandidates
        .filter(resource => !resource.trusted)
        .map(resource => resource.url),
    )];

    if (untrustedUrls.length > 0) {
      const approval = await requestWebApproval(event.toolName, event.input, untrustedUrls, ctx);
      if (!approval.allow) {
        return {
          block: true,
          reason: approval.reason,
          terminate: approval.terminate,
        };
      }
    }

    const canonicalTool = canonicalizeToolName(event.toolName);

    if (canonicalTool === "web_fetch") {
      const input = event.input as { url?: string };
      if (input?.url) {
        pendingWebfetchUrls.set(event.toolCallId, input.url);
      }
      return;
    }

    if (canonicalTool === "bash") {
      const input = event.input as { command?: string };
      if (input?.command) {
        pendingBashCommands.set(event.toolCallId, input.command);
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const canonicalTool = canonicalizeToolName(event.toolName);

    if (canonicalTool === "web_fetch") {
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

    if (canonicalTool === "bash") {
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

    if (event.isError || canonicalTool !== "read") return;
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

  pi.registerCommand("web-render", {
    description: "Set URL rendering layout  |  args: old | new | status",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      if (!arg || arg === "status") {
        ctx.ui.notify(`Web render layout: ${webRenderLayout}`, "info");
        return;
      }

      if (arg === "old" || arg === "new") {
        webRenderLayout = arg;
        persistState();
        updateWidget(ctx);
        ctx.ui.notify(`Web render layout: ${webRenderLayout}`, "info");
        return;
      }

      ctx.ui.notify("Usage: /web-render old|new|status", "warning");
    },
  });

  pi.registerCommand("web-approval", {
    description: "Control untrusted URL handling  |  args: ask | approve | deny | status | list",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      if (!arg || arg === "status") {
        ctx.ui.notify(`Web approval: ${webApprovalMode}`, "info");
        return;
      }

      if (arg === "list") {
        if (trustedHostPatterns.length === 0) {
          ctx.ui.notify("Trusted URL patterns: (none)", "info");
          return;
        }
        const patternList = trustedHostPatterns.map(pattern => pattern.raw).join("\n  - ");
        ctx.ui.notify(`Trusted URL patterns:\n  - ${patternList}`, "info");
        return;
      }

      if (arg === "ask" || arg === "approve" || arg === "deny") {
        webApprovalMode = arg;
        persistState();
        ctx.ui.notify(`Web approval: ${webApprovalMode}`, "info");
        return;
      }

      ctx.ui.notify("Usage: /web-approval ask|approve|deny|status|list", "warning");
    },
  });
}
