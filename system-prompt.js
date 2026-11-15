/**
 * system-prompt.js — session bootstrap from shell commands.
 *
 * On /new session:
 * - load .systempromptrc
 * - run commands (one per line) sequentially
 * - capture full stdout/stderr (no custom truncation)
 * - inject + display exactly what was injected
 */

import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
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

function parseCommands(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
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
    path.join(xdg, "brainjam", ".systempromptrc"), // legacy folder name
    path.join(xdg, "brainjam", "systempromptrc"), // legacy folder name
    path.join(home, ".systempromptrc"),

    // Pi-specific fallbacks.
    path.join(home, ".pi", "system-prompt", ".systempromptrc"),
    path.join(home, ".pi", "system-prompt", "systempromptrc"),
    path.join(home, ".pi", "agent", "systempromptrc"),
  ];

  return unique(candidates.map((p) => path.resolve(p)));
}

async function loadConfig(cwd) {
  const candidates = candidateConfigPaths(cwd);

  for (const filePath of candidates) {
    if (!(await existsFile(filePath))) continue;
    const raw = await readFile(filePath, "utf8");
    const commands = parseCommands(raw);
    return { config: { path: filePath, raw, commands }, candidates };
  }

  return { config: null, candidates };
}

function unique(items) {
  return [...new Set(items)];
}

async function runCommand(pi, command, signal) {
  if (process.platform === "win32") {
    return pi.exec("cmd", ["/d", "/s", "/c", command], { signal });
  }
  return pi.exec("sh", ["-lc", command], { signal });
}

function formatConfigWithExitCodes(commands, results) {
  const lines = [];

  for (let i = 0; i < commands.length; i += 1) {
    const command = commands[i];
    const exitCode = results[i]?.exitCode;
    lines.push(`${command} -> ${exitCode ?? "?"}`);
  }

  return lines.join("\n") || "(empty)";
}

function collectOutput(results, stream) {
  return results
    .map((result) => result[stream] || "")
    .join("");
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/, 1)[0] || "system prompt bootstrap";
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

  // Legacy message tags for backward compatibility.
  pi.registerMessageRenderer("brainjam-bootstrap", renderSystemPromptMessage);
  pi.registerMessageRenderer("bootstrap-brainjam", renderSystemPromptMessage);

  let cachedConfig = null;
  let bootstrapContent = null;
  let bootstrapReady = Promise.resolve();
  let bootstrapPostedForSession = false;

  async function postBootstrap(content) {
    if (!content || bootstrapPostedForSession) return;
    bootstrapPostedForSession = true;

    await pi.sendMessage({
      customType: "system-prompt-bootstrap",
      content,
      display: true,
    });
  }

  pi.on("session_start", async (event, ctx) => {
    bootstrapReady = (async () => {
      bootstrapPostedForSession = false;

      const configResult = await loadConfig(ctx.cwd);
      cachedConfig = configResult.config;
      bootstrapContent = null;

      // Run bootstrap only for freshly-created sessions.
      const shouldRunBootstrap = event.reason === "new";

      // Ignore startup/reload/resume/fork.
      if (!shouldRunBootstrap) return;

      const timeoutController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        timeoutController.abort(new Error(`system prompt bootstrap timed out after ${BOOTSTRAP_TIMEOUT_MS}ms`));
      }, BOOTSTRAP_TIMEOUT_MS);

      try {
        if (!cachedConfig) {
          const looked = configResult.candidates.map((p) => `- ${p}`).join("\n");
          await postBootstrap(`❌ System Prompt: no config found (.systempromptrc not loaded).

Checked ${configResult.candidates.length} locations (in order):
${looked}`);
          return;
        }

        const results = [];
        let timedOut = false;

        for (const line of cachedConfig.commands) {
          if (timeoutController.signal.aborted) {
            timedOut = true;
            break;
          }

          try {
            const execResult = await runCommand(pi, line, timeoutController.signal);
            results.push({
              command: line,
              stdout: execResult.stdout ?? "",
              stderr: execResult.stderr ?? "",
              exitCode: execResult.exitCode ?? 0,
            });
          } catch (err) {
            const errorText = err instanceof Error ? err.message : String(err);
            const wasTimeout = timeoutController.signal.aborted || /timed out|abort/i.test(errorText);
            if (wasTimeout) timedOut = true;

            results.push({
              command: line,
              stdout: "",
              stderr: wasTimeout ? `Timed out after ${BOOTSTRAP_TIMEOUT_MS}ms` : errorText,
              exitCode: wasTimeout ? 124 : 1,
            });

            if (wasTimeout) break;
          }
        }

        const failures = results.filter((r) => r.exitCode !== 0).length;
        const summary = timedOut || failures > 0
          ? `❌ System Prompt failed${timedOut ? ` (timed out at ${BOOTSTRAP_TIMEOUT_MS}ms)` : ""}${failures > 0 ? ` (${failures} command issue(s))` : ""}`
          : "✅ System Prompt loaded.";

        const configWithExitCodes = formatConfigWithExitCodes(
          cachedConfig.commands,
          results,
        );
        const stdoutContent = collectOutput(results, "stdout");
        const stderrContent = collectOutput(results, "stderr");

        bootstrapContent = `${summary}

Config source: ${cachedConfig.path}

${configWithExitCodes}

# STDOUT
${stdoutContent}${stderrContent ? `\n\n# STDERR\n${stderrContent}` : ""}`;

        await postBootstrap(bootstrapContent);
      } finally {
        clearTimeout(timeoutHandle);
      }
    })();

    await bootstrapReady;
  });
}
