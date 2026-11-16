/**
 * system-prompt.js — session bootstrap from shell commands.
 *
 * On fresh startup or /new session:
 * - load .systempromptrc
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

const BOOTSTRAP_TIMEOUT_MS = 10_000;

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
    path.join(cwd, ".systempromptrc"),

    // Common user-level config locations.
    path.join(xdg, "system-prompt", ".systempromptrc"),
    path.join(home, ".systempromptrc"),

    // Pi-specific fallbacks.
    path.join(home, ".pi", "system-prompt", ".systempromptrc"),
    path.join(home, ".pi", "agent", ".systempromptrc"),
  ];

  return unique(candidates.map((p) => path.resolve(p)));
}

function inScope(filePath, cwd, scope = "all") {
  const local = path.resolve(cwd, ".systempromptrc");
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
  const lines = text.split(/\r?\n/);
  const first = (lines[0] ?? "").trim();
  const checksumMatch = first.match(/^@([A-Za-z0-9]{8})$/);
  const checksum = checksumMatch ? checksumMatch[1] : "";
  const body = checksum ? lines.slice(1).join("\n") : text;
  const hashkey = passkey ? makeHashkey(passkey, body) : "";
  const safe = Boolean(checksum && hashkey && checksum === hashkey);

  return {
    checksum,
    body,
    hashkey,
    safe,
  };
}

function parseSystemPromptCommandArgs(args) {
  const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  const action = tokens[0] ?? "";
  const flags = new Set(tokens.slice(1));

  if (action !== "grant" && action !== "revoke" && action !== "locate") {
    return { error: "Usage: /system-prompt <grant|revoke|locate> [--local|--global]" };
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

function serializeRC(body, checksum) {
  if (!checksum) return body;
  return body ? `@${checksum}\n${body}` : `@${checksum}`;
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

function launchedWithNoSystemPromptFlag(argv = process.argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--no-system-prompt") return true;
    if (arg.startsWith("--system-prompt=") && arg.slice("--system-prompt=".length) === "false") return true;

    if (arg === "--system-prompt") {
      const next = args[i + 1] ?? "";
      if (next === "false") return true;
    }
  }

  return false;
}

async function runCommand(pi, command, signal) {
  if (process.platform === "win32") {
    return pi.exec("cmd", ["/d", "/s", "/c", command], { signal });
  }
  return pi.exec("sh", ["-lc", command], { signal });
}


function firstLine(text) {
  return String(text || "").split(/\r?\n/, 1)[0] || "system prompt bootstrap";
}

function trimTrailingBlankLines(text) {
  return String(text ?? "").replace(/(?:\r?\n[\t ]*)+$/u, "");
}

function withFinalBlankLine(text) {
  const trimmed = trimTrailingBlankLines(text);
  return trimmed ? `${trimmed}\n\n` : "";
}

function formatScriptSection(body) {
  return trimTrailingBlankLines(body);
}

function formatPromptSection(stdout, stderr) {
  const out = trimTrailingBlankLines(stdout);
  const err = trimTrailingBlankLines(stderr);
  return [out, err].filter(Boolean).join("\n\n");
}

function renderSystemPromptMessage(message, options, theme) {
  const content = String(message?.content ?? "");
  const summary = firstLine(content);
  let text = `${theme.fg("accent", "[system-prompt]")} ${summary}`;

  if (options.expanded) {
    text += `\n\n${content}`;
  } else {
    text += ` ${theme.fg("dim", `(${options.keyHint("app.tools.expand", "expand")})`)}`;
  }

  const bgColor = theme.colors.customMessageBg;
  const fgColor = theme.colors.terminalFg;
  const styled = theme.style(text, { bg: bgColor, fg: fgColor });

  const box = new Box(options.outputPad, 0);
  box.addChild(new Text(styled, 0, 0));
  return box;
}


/**
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function systemPromptExtension(pi) {
  pi.registerFlag("no-system-prompt", {
    description: "Disable trusted .systempromptrc bootstrap execution",
    type: "boolean",
    default: false,
  });

  if (launchedWithNoSystemPromptFlag()) return;

  pi.registerMessageRenderer("system-prompt-bootstrap", renderSystemPromptMessage);

  let bootstrapReady = Promise.resolve();

  async function postBootstrap(content) {
    const normalized = withFinalBlankLine(content);
    if (!normalized) return;

    await pi.sendMessage({
      customType: "system-prompt-bootstrap",
      content: normalized,
      display: true,
    });
  }

  pi.registerCommand("system-prompt", {
    description: "Grant, revoke, or locate .systempromptrc files",
    handler: async (args, ctx) => {
      const parsed = parseSystemPromptCommandArgs(args);
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
        const passkey = String(process.env.SYSTEMPROMPT_PASSKEY ?? "").trim();
        if (!passkey) {
          ctx.ui.notify("SYSTEMPROMPT_PASSKEY is required for grant.", "error");
          return;
        }

        for (const config of configs) {
          const currentRaw = await readFile(config.path, "utf8");
          const rc = readRC(currentRaw, passkey);
          const checksum = makeHashkey(passkey, rc.body);
          await writeFile(config.path, serializeRC(rc.body, checksum), "utf8");
        }

        ctx.ui.notify(`Granted ${configs.length} rc file(s).`, "info");
        return;
      }

      for (const config of configs) {
        const currentRaw = await readFile(config.path, "utf8");
        const rc = readRC(currentRaw, "");
        await writeFile(config.path, serializeRC(rc.body, ""), "utf8");
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

      const passkey = String(process.env.SYSTEMPROMPT_PASSKEY ?? "").trim();
      if (!passkey) {
        for (const config of configs) {
          const configPath = toHomeTilde(config.path);
          const rc = readRC(config.raw, passkey);
          await postBootstrap(`⚠️ ${configPath}
Missing SYSTEMPROMPT_PASSKEY. Skipped processing.

${formatScriptSection(rc.body)}`);
        }
        return;
      }

      for (const config of configs) {
        const configPath = toHomeTilde(config.path);
        const rc = readRC(config.raw, passkey);

        if (!rc.checksum) {
          await postBootstrap(`🔒 ${configPath}
Missing checksum line. Expected first line format: @XXXXXXXX

${formatScriptSection(rc.body)}`);
          continue;
        }

        if (!rc.safe) {
          await postBootstrap(`☠️ ${configPath}
Checksum mismatch. checksum=${rc.checksum} hashkey=${rc.hashkey}

${formatScriptSection(rc.body)}`);
          continue;
        }

        const timeoutController = new AbortController();
        const timeoutHandle = setTimeout(() => {
          timeoutController.abort(new Error(`system prompt bootstrap timed out after ${BOOTSTRAP_TIMEOUT_MS}ms`));
        }, BOOTSTRAP_TIMEOUT_MS);

        let exitCode = 0;
        let stdoutContent = "";
        let stderrContent = "";
        let timedOut = false;

        try {
          const execResult = await runCommand(pi, rc.body, timeoutController.signal);
          exitCode = execResult.exitCode ?? 0;
          stdoutContent = execResult.stdout ?? "";
          stderrContent = execResult.stderr ?? "";
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          const wasTimeout = timeoutController.signal.aborted || /timed out|abort/i.test(errorText);
          timedOut = wasTimeout;
          exitCode = wasTimeout ? 124 : 1;
          stderrContent = wasTimeout ? `Timed out after ${BOOTSTRAP_TIMEOUT_MS}ms` : errorText;
        } finally {
          clearTimeout(timeoutHandle);
        }

        const hasFailure = exitCode !== 0;
        const heading = `${hasFailure ? "❌" : "✅"} ${configPath}`;
        const detail = timedOut
          ? `exit code ${exitCode} • Timed out at ${BOOTSTRAP_TIMEOUT_MS}ms`
          : hasFailure
            ? `exit code ${exitCode}`
            : "";

        const scriptSection = formatScriptSection(rc.body);
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
