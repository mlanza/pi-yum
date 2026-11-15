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
    path.join(xdg, "system-prompt", "systempromptrc"),
    path.join(home, ".systempromptrc"),

    // Pi-specific fallbacks.
    path.join(home, ".pi", "system-prompt", ".systempromptrc"),
    path.join(home, ".pi", "system-prompt", "systempromptrc"),
    path.join(home, ".pi", "agent", "systempromptrc"),
  ];

  return unique(candidates.map((p) => path.resolve(p)));
}

function selectCandidates(cwd, scope = "all") {
  const all = candidateConfigPaths(cwd);
  const local = path.resolve(cwd, ".systempromptrc");

  if (scope === "local") return all.filter((p) => p === local);
  if (scope === "global") return all.filter((p) => p !== local);
  return all;
}

async function loadConfigs(cwd, scope = "all") {
  const candidates = selectCandidates(cwd, scope);
  const configs = [];

  for (const filePath of candidates) {
    if (!(await existsFile(filePath))) continue;
    const raw = await readFile(filePath, "utf8");
    configs.push({ path: filePath, raw });
  }

  return { configs, candidates };
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

  if (action !== "grant" && action !== "revoke") {
    return { error: "Usage: /system-prompt <grant|revoke> [--local|--global]" };
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

async function runCommand(pi, command, signal) {
  if (process.platform === "win32") {
    return pi.exec("cmd", ["/d", "/s", "/c", command], { signal });
  }
  return pi.exec("sh", ["-lc", command], { signal });
}


function firstLine(text) {
  return String(text || "").split(/\r?\n/, 1)[0] || "system prompt bootstrap";
}

function formatStdinSection(body) {
  return `# STDIN\n${body || "(empty)"}`;
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

  const box = new Box(options.outputPad, 1);
  box.addChild(new Text(styled, 0, 0));
  return box;
}


/**
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function systemPromptExtension(pi) {
  pi.registerMessageRenderer("system-prompt-bootstrap", renderSystemPromptMessage);

  let bootstrapReady = Promise.resolve();

  async function postBootstrap(content) {
    if (!content) return;

    await pi.sendMessage({
      customType: "system-prompt-bootstrap",
      content,
      display: true,
    });
  }

  pi.registerCommand("system-prompt", {
    description: "Grant or revoke system prompt rc checksums",
    handler: async (args, ctx) => {
      const parsed = parseSystemPromptCommandArgs(args);
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      const cwd = ctx.cwd || process.cwd();
      const { action, scope } = parsed;
      const configResult = await loadConfigs(cwd, scope);
      const configs = configResult.configs;

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
      const configResult = await loadConfigs(ctx.cwd);
      const configs = configResult.configs;

      // Run bootstrap for /new and startup launches, except when launched with continue mode (`pi -c`).
      const continuedLaunch = launchedWithContinueFlag();
      const shouldRunBootstrap = event.reason === "new" || (event.reason === "startup" && !continuedLaunch);

      // Ignore reload/resume/fork and startup with continue mode.
      if (!shouldRunBootstrap) return;

      if (configs.length === 0) {
        const looked = configResult.candidates.map((p) => `- ${toHomeTilde(p)}`).join("\n");
        await postBootstrap(`❌ .systempromptrc
No config found.

Checked ${configResult.candidates.length} locations (in order):
${looked}`);
        return;
      }

      const passkey = String(process.env.SYSTEMPROMPT_PASSKEY ?? "").trim();
      if (!passkey) {
        for (const config of configs) {
          const configPath = toHomeTilde(config.path);
          const rc = readRC(config.raw, passkey);
          await postBootstrap(`⚠️ ${configPath}
Missing SYSTEMPROMPT_PASSKEY. Skipped processing.

${formatStdinSection(rc.body)}`);
        }
        return;
      }

      for (const config of configs) {
        const configPath = toHomeTilde(config.path);
        const rc = readRC(config.raw, passkey);

        if (!rc.checksum) {
          await postBootstrap(`🔒 ${configPath}
Missing checksum line. Expected first line format: @XXXXXXXX

${formatStdinSection(rc.body)}`);
          continue;
        }

        if (!rc.safe) {
          await postBootstrap(`☠️ ${configPath}
Checksum mismatch. checksum=${rc.checksum} hashkey=${rc.hashkey}

${formatStdinSection(rc.body)}`);
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

        const bootstrapContent = `${heading}${detail ? `\n${detail}` : ""}

${formatStdinSection(rc.body)}

# STDOUT
${stdoutContent}${stderrContent ? `\n\n# STDERR\n${stderrContent}` : ""}`;

        await postBootstrap(bootstrapContent);
      }
    })();

    await bootstrapReady;
  });
}
