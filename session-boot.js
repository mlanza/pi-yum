/**
 * session-boot.js — session bootstrap from shell commands.
 *
 * On fresh startup or /new session:
 * - load .sessionbootrc
 * - run the full rc body as one shell script
 * - capture full stdout/stderr (no custom truncation)
 * - inject + display exactly what was injected
 */

import { access, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { Box, Text } from "@earendil-works/pi-tui";

const BOOT_TIMEOUT_MS = 10_000;
const SESSIONBOOT_SAMPLES_FLAG = "sessionboot-samples";
const CHECKSUM_PATTERN = /^#checksum: ([A-Za-z0-9]{8})[\t ]*(?:\r?\n|$)/gm;

async function existsFile(filePath) {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateConfigPaths(cwd) {
  const home = path.resolve(os.homedir());
  const xdgRaw = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const xdg = path.isAbsolute(xdgRaw) ? xdgRaw : path.resolve(cwd, xdgRaw);

  const candidates = [
    // Always check cwd first.
    path.join(cwd, ".sessionbootrc"),

    // Common user-level config locations.
    path.join(xdg, "session-boot", ".sessionbootrc"),
    path.join(home, ".sessionbootrc"),

    // Pi-specific fallbacks.
    path.join(home, ".pi", "session-boot", ".sessionbootrc"),
    path.join(home, ".pi", "agent", ".sessionbootrc"),
  ];

  return unique(candidates.map((p) => path.resolve(p)));
}

function inScope(filePath, cwd, scope = "all") {
  const local = path.resolve(cwd, ".sessionbootrc");
  if (scope === "local") return filePath === local;
  if (scope === "global") return filePath !== local;
  return true;
}

async function locateConfigs(cwd, scope = "all") {
  const candidates = candidateConfigPaths(cwd).filter((filePath) => inScope(filePath, cwd, scope));
  const files = [];

  for (const filePath of candidates) {
    const exists = await existsFile(filePath);
    const raw = exists ? await readFile(filePath, "utf8") : "";
    files.push({ path: filePath, exists, raw });
  }

  const configs = files.filter((file) => file.exists).map((file) => ({ path: file.path, raw: file.raw }));
  return { candidates, files, configs };
}

function unique(items) {
  return [...new Set(items)];
}

function toHomeTilde(filePath) {
  const home = path.resolve(os.homedir());
  const resolved = path.resolve(filePath);
  if (resolved === home) return "~";
  if (resolved.startsWith(`${home}${path.sep}`)) return `~${resolved.slice(home.length)}`;
  return filePath;
}

function makeHashkey(passkey, body) {
  const digest = createHash("sha256")
    .update(`${passkey}\n${body}`)
    .digest("base64")
    .replace(/[^A-Za-z0-9]/g, "");

  return digest.slice(0, 8);
}

function readRC(raw, passkey) {
  const text = String(raw ?? "");
  const matches = [...text.matchAll(CHECKSUM_PATTERN)];
  const checksum = matches.length === 1 ? matches[0][1] : "";
  // Exclude trust markers from hashing and display; execute the original file.
  const body = serializeRC(text, "");
  const hashkey = passkey ? makeHashkey(passkey, body) : "";
  const safe = Boolean(checksum && hashkey && checksum === hashkey);

  return {
    checksum,
    body,
    hashkey,
    safe,
  };
}

function parseSessionBootCommandArgs(args) {
  const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  const action = tokens[0] ?? "";
  const flags = new Set(tokens.slice(1));

  if (action !== "grant" && action !== "revoke" && action !== "locate") {
    return { error: "Usage: /session-boot <grant|revoke|locate> [--local|--global]" };
  }

  const hasLocal = flags.has("--local");
  const hasGlobal = flags.has("--global");
  if (hasLocal && hasGlobal) {
    return { error: "Choose one scope: --local or --global (not both)." };
  }

  const unknownFlags = [...flags].filter((f) => f !== "--local" && f !== "--global");
  if (unknownFlags.length > 0) {
    return { error: `Unknown flag(s): ${unknownFlags.join(", ")}` };
  }

  const scope = hasLocal ? "local" : hasGlobal ? "global" : "all";
  return { action, scope };
}

function serializeRC(raw, checksum) {
  const text = String(raw ?? "");
  const matches = [...text.matchAll(CHECKSUM_PATTERN)];
  const body = text.replace(CHECKSUM_PATTERN, "");
  if (!checksum) return body;

  const comment = `#checksum: ${checksum}`;
  if (matches.length > 0) {
    // Replace at the first marker's original position and remove any duplicates.
    const first = matches[0];
    const ending = first[0].match(/\r?\n$/)?.[0] ?? "";
    return `${body.slice(0, first.index)}${comment}${ending}${body.slice(first.index)}`;
  }

  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const shebang = body.match(/^#![^\r\n]*(?:\r?\n|$)/);
  if (!shebang) return body ? `${comment}${newline}${body}` : comment;

  const first = shebang[0];
  const separator = first.endsWith("\n") ? "" : newline;
  const rest = body.slice(first.length);
  return `${first}${separator}${comment}${rest ? `${newline}${rest}` : ""}`;
}

function launchedWithContinueFlag(argv = process.argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "-c" || arg === "--continue") return true;
    if (arg.startsWith("--continue=")) return true;
  }

  return false;
}

function launchedWithNoSessionBootFlag(argv = process.argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--no-session-boot") return true;
    if (arg.startsWith("--session-boot=") && arg.slice("--session-boot=".length) === "false") return true;

    if (arg === "--session-boot") {
      const next = args[i + 1] ?? "";
      if (next === "false") return true;
    }
  }

  return false;
}

async function runCommand(pi, command, signal) {
  return pi.exec("bash", ["-lc", command], { signal });
}


function firstLine(text) {
  return String(text || "").split(/\r?\n/, 1)[0] || "session boot";
}

function trimTrailingBlankLines(text) {
  return String(text ?? "").replace(/(?:\r?\n[\t ]*)+$/u, "");
}

function withFinalBlankLine(text) {
  const trimmed = trimTrailingBlankLines(text);
  return trimmed ? `${trimmed}\n\n` : "";
}

function formatScriptSection(raw) {
  return serializeRC(raw, "");
}

function formatPromptSection(stdout, stderr) {
  const out = trimTrailingBlankLines(stdout);
  const err = trimTrailingBlankLines(stderr);
  return [out, err].filter(Boolean).join("\n\n");
}

function renderSessionBootMessage(message, options, theme) {
  const content = String(message?.content ?? "");
  const summary = firstLine(content);
  let text = `${theme.fg("success", "[session-boot]")} ${theme.fg("text", summary)}`;

  if (options.expanded) {
    text += `\n\n${theme.fg("text", content)}`;
  } else {
    text += ` ${theme.fg("dim", `(${options.keyHint("app.tools.expand", "expand")})`)}`;
  }

  const box = new Box(options.outputPad, 0, (line) => theme.bg("toolSuccessBg", line));
  box.addChild(new Text(text, 0, 0));
  return box;
}


// Optional theme samples, enabled with --sessionboot-samples.
function registerTemporaryColorTests(pi) {
  const palettes = [
    { label: "customMessageLabel", text: "customMessageText", bg: "customMessageBg" },
    { label: "accent", text: "text", bg: "userMessageBg" },
    { label: "warning", text: "toolOutput", bg: "toolPendingBg" },
    { label: "success", text: "text", bg: "toolSuccessBg" },
    { label: "error", text: "muted", bg: "toolErrorBg" },
    // Quieter combinations: use each surface's own text roles.
    { label: "muted", text: "text" },
    { label: "dim", text: "muted" },
    { label: "customMessageLabel", text: "customMessageText", bg: "customMessageBg" },
    { label: "muted", text: "userMessageText", bg: "userMessageBg" },
    { label: "toolTitle", text: "toolOutput", bg: "toolPendingBg" },
  ];

  pi.registerEntryRenderer("session-boot-color-test", (entry, options, theme) => {
    const { index } = entry.data;
    const palette = palettes[index];
    const box = new Box(options.outputPad, 0,
      palette.bg ? (line) => theme.bg(palette.bg, line) : undefined);
    const summary = `${palette.label} + ${palette.text} on ${palette.bg ?? "default background"}`;
    let text = `${theme.fg(palette.label, `[color test ${index + 1}]`)} ${theme.fg(palette.text, summary)}`;
    if (options.expanded) {
      text += `\n\n${theme.fg(palette.text, [
        "Sample bootstrap report",
        "Loaded project settings and checked the working folder.",
        "",
        "#!/usr/bin/env bash",
        'printf "%s\\n" "Ready for work"',
        "",
        "↓↓↓",
        "",
        "Ready for work",
        "No warnings. No errors.",
      ].join("\n"))}`;
    } else {
      text += ` ${theme.fg("dim", `(${options.keyHint("app.tools.expand", "expand")})`)}`;
    }
    box.addChild(new Text(text, 0, 0));
    return box;
  });

  return () => {
    palettes.forEach((_, index) => pi.appendEntry("session-boot-color-test", { index }));
  };
}

/**
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function sessionBootExtension(pi) {
  pi.registerFlag("no-session-boot", {
    description: "Disable trusted .sessionbootrc bootstrap execution",
    type: "boolean",
    default: false,
  });

  pi.registerFlag(SESSIONBOOT_SAMPLES_FLAG, {
    description: "Show session-boot theme samples above bootstrap reports",
    type: "boolean",
    default: false,
  });

  if (launchedWithNoSessionBootFlag()) return;

  pi.registerMessageRenderer("session-boot-bootstrap", renderSessionBootMessage);
  // Keep reports in existing sessions readable after the rename.
  pi.registerMessageRenderer("system-prompt-bootstrap", renderSessionBootMessage);

  const postTemporaryColorTests = registerTemporaryColorTests(pi);
  let bootstrapReady = Promise.resolve();

  async function postBootstrap(content) {
    const normalized = withFinalBlankLine(content);
    if (!normalized) return;

    if (pi.getFlag(SESSIONBOOT_SAMPLES_FLAG)) postTemporaryColorTests();
    await pi.sendMessage({
      customType: "session-boot-bootstrap",
      content: normalized,
      display: true,
    });
  }

  pi.registerCommand("session-boot", {
    description: "Grant, revoke, or locate .sessionbootrc files",
    handler: async (args, ctx) => {
      const parsed = parseSessionBootCommandArgs(args);
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      const cwd = ctx.cwd || process.cwd();
      const { action, scope } = parsed;
      const configResult = await locateConfigs(cwd, scope);
      const configs = configResult.configs;

      if (action === "locate") {
        const lines = configResult.files.map((file) => {
          const marker = file.exists ? "✅" : "•";
          return `${marker} ${toHomeTilde(file.path)}`;
        });
        const detail = configs.length === 0 ? "\n\nNo config found." : "";
        ctx.ui.notify(`Lookup order (${scope}):\n${lines.join("\n")}${detail}`, "info");
        return;
      }

      if (configs.length === 0) {
        ctx.ui.notify("No matching rc files found.", "warning");
        return;
      }

      if (action === "grant") {
        const passkey = String(process.env.SESSIONBOOT_PASSKEY ?? "").trim();
        if (!passkey) {
          ctx.ui.notify("SESSIONBOOT_PASSKEY is required for grant.", "error");
          return;
        }

        for (const config of configs) {
          const currentRaw = await readFile(config.path, "utf8");
          // Inserting after a shebang-only file may introduce its missing newline.
          const unsigned = readRC(serializeRC(currentRaw, "00000000"), passkey);
          await writeFile(config.path, serializeRC(currentRaw, unsigned.hashkey), "utf8");
        }

        ctx.ui.notify(`Granted ${configs.length} rc file(s).`, "info");
        return;
      }

      for (const config of configs) {
        const currentRaw = await readFile(config.path, "utf8");
        await writeFile(config.path, serializeRC(currentRaw, ""), "utf8");
      }

      ctx.ui.notify(`Revoked ${configs.length} rc file(s).`, "info");
    },
  });

  pi.on("session_start", async (event, ctx) => {
    bootstrapReady = (async () => {
      const configResult = await locateConfigs(ctx.cwd);
      const configs = configResult.configs;

      // Run bootstrap for /new and startup launches, except when launched with continue mode (`pi -c`).
      const continuedLaunch = launchedWithContinueFlag();
      const shouldRunBootstrap = event.reason === "new" || (event.reason === "startup" && !continuedLaunch);

      // Ignore reload/resume/fork and startup with continue mode.
      if (!shouldRunBootstrap) return;

      if (configs.length === 0) return;

      const passkey = String(process.env.SESSIONBOOT_PASSKEY ?? "").trim();
      if (!passkey) {
        for (const config of configs) {
          const configPath = toHomeTilde(config.path);
          await postBootstrap(`⚠️ ${configPath}
Missing SESSIONBOOT_PASSKEY. Skipped processing.

${formatScriptSection(config.raw)}`);
        }
        return;
      }

      for (const config of configs) {
        const configPath = toHomeTilde(config.path);
        const rc = readRC(config.raw, passkey);

        if (!rc.checksum) {
          await postBootstrap(`🔒 ${configPath}
Missing or duplicate checksum line. Expected one comment anywhere: #checksum: XXXXXXXX

${formatScriptSection(config.raw)}`);
          continue;
        }

        if (!rc.safe) {
          await postBootstrap(`☠️ ${configPath}
Checksum mismatch. checksum=${rc.checksum} hashkey=${rc.hashkey}

${formatScriptSection(config.raw)}`);
          continue;
        }

        const timeoutController = new AbortController();
        const timeoutHandle = setTimeout(() => {
          timeoutController.abort(new Error(`session boot timed out after ${BOOT_TIMEOUT_MS}ms`));
        }, BOOT_TIMEOUT_MS);

        let exitCode = 0;
        let stdoutContent = "";
        let stderrContent = "";
        let timedOut = false;

        try {
          const execResult = await runCommand(pi, config.raw, timeoutController.signal);
          exitCode = execResult.exitCode ?? 0;
          stdoutContent = execResult.stdout ?? "";
          stderrContent = execResult.stderr ?? "";
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          const wasTimeout = timeoutController.signal.aborted || /timed out|abort/i.test(errorText);
          timedOut = wasTimeout;
          exitCode = wasTimeout ? 124 : 1;
          stderrContent = wasTimeout ? `Timed out after ${BOOT_TIMEOUT_MS}ms` : errorText;
        } finally {
          clearTimeout(timeoutHandle);
        }

        const hasFailure = exitCode !== 0;
        const heading = `${hasFailure ? "❌" : "✅"} ${configPath}`;
        const detail = timedOut
          ? `exit code ${exitCode} • Timed out at ${BOOT_TIMEOUT_MS}ms`
          : hasFailure
            ? `exit code ${exitCode}`
            : "";

        const scriptSection = formatScriptSection(config.raw);
        const promptSection = formatPromptSection(stdoutContent, stderrContent);

        const bootstrapContent = `${heading}${detail ? `\n${detail}` : ""}

${scriptSection}

↓↓↓

${promptSection}`;

        await postBootstrap(bootstrapContent);
      }
    })();

    await bootstrapReady;
  });
}
