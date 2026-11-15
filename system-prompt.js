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

function shellQuote(filePath) {
  if (process.platform === "win32") {
    return `"${filePath.replaceAll('"', '""')}"`;
  }
  return `'${filePath.replaceAll("'", "'\\''")}'`;
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

function extractPathLikeTokens(prompt) {
  const hits = [];

  const fenced = prompt.match(/`([^`]+)`/g) || [];
  for (const m of fenced) hits.push(m.slice(1, -1));

  const quoted = prompt.match(/"([^"]+)"|'([^']+)'/g) || [];
  for (const m of quoted) hits.push(m.slice(1, -1));

  const bare = prompt.match(/(?:\.{1,2}\/|~\/|\/)?[\w@.%+-]+(?:\/[\w@.%+\-]+)*(?:\.[\w.-]+)?/g) || [];
  for (const m of bare) hits.push(m);

  return unique(
    hits
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => s.includes("/") || s.startsWith(".") || /\.[A-Za-z0-9]{1,8}$/.test(s)),
  );
}

function resolvePromptPath(rawPath, cwd) {
  const expanded = rawPath.startsWith("~/")
    ? path.join(os.homedir(), rawPath.slice(2))
    : rawPath;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded);
}

async function findMentionedFile(prompt, cwd) {
  const candidates = extractPathLikeTokens(prompt);
  for (const c of candidates) {
    const resolved = resolvePromptPath(c, cwd);
    if (await existsFile(resolved)) return resolved;
  }
  return null;
}

function expandCommand(command, filePath) {
  if (!filePath) return command;
  const quoted = shellQuote(filePath);
  return command.replaceAll("{{file}}", quoted).replaceAll("{file}", quoted);
}

async function runCommand(pi, command, signal) {
  if (process.platform === "win32") {
    return pi.exec("cmd", ["/d", "/s", "/c", command], { signal });
  }
  return pi.exec("sh", ["-lc", command], { signal });
}

function formatCommandResult(result) {
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";

  let body = `$ ${result.command}\nexit: ${result.exitCode}`;
  if (stdout.length > 0) body += `\nstdout:\n${stdout}`;
  if (stderr.length > 0) body += `\nstderr:\n${stderr}`;
  return body;
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
  pi.registerMessageRenderer("system-prompt-file-bootstrap", renderSystemPromptMessage);

  // Legacy message tags for backward compatibility.
  pi.registerMessageRenderer("brainjam-bootstrap", renderSystemPromptMessage);
  pi.registerMessageRenderer("bootstrap-brainjam", renderSystemPromptMessage);
  pi.registerMessageRenderer("brainjam-file-bootstrap", renderSystemPromptMessage);

  let cachedConfig = null;
  let pendingFileCommands = [];
  let fileCommandsSeeded = false;
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
      pendingFileCommands = [];
      fileCommandsSeeded = false;
      bootstrapContent = null;

      // Run full bootstrap for true startup/new sessions.
      const shouldRunBootstrap = event.reason === "new" || event.reason === "startup";

      // Ignore non-startup session reasons.
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

        const immediateCommands = [];
        for (const cmd of cachedConfig.commands) {
          if (/\{\{file\}\}|\{file\}/.test(cmd)) pendingFileCommands.push(cmd);
          else immediateCommands.push(cmd);
        }

        const results = [];
        let timedOut = false;

        for (const line of immediateCommands) {
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

        const blocks = results.length > 0
          ? results.map(formatCommandResult).join("\n\n---\n\n")
          : "(no non-file commands to run at session start)";

        const pendingLine = pendingFileCommands.length > 0
          ? `File-aware commands deferred: ${pendingFileCommands.length} (run when a prompt mentions a file path).`
          : "File-aware commands deferred: 0";

        bootstrapContent = `${summary}

Config source: ${cachedConfig.path}
Prompt file detected: (none at session start)
${pendingLine}

Config contents:
${cachedConfig.raw.trim() || "(empty)"}

Captured command run:

${blocks}`;

        await postBootstrap(bootstrapContent);
      } finally {
        clearTimeout(timeoutHandle);
      }
    })();

    await bootstrapReady;
  });

  // Deferred {file} commands, executed once when first relevant prompt appears.
  pi.on("before_agent_start", async (event, ctx) => {
    await bootstrapReady;

    if (!fileCommandsSeeded && event.messageType === "user" && cachedConfig && pendingFileCommands.length > 0) {
      const filePath = await findMentionedFile(event.prompt ?? "", ctx.cwd);
      if (!filePath) return;

      fileCommandsSeeded = true;

      const results = [];
      for (const line of pendingFileCommands) {
        const expanded = expandCommand(line, filePath);
        try {
          const execResult = await runCommand(pi, expanded);
          results.push({
            command: expanded,
            stdout: execResult.stdout ?? "",
            stderr: execResult.stderr ?? "",
            exitCode: execResult.exitCode ?? 0,
          });
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          results.push({
            command: expanded,
            stdout: "",
            stderr: errorText,
            exitCode: 1,
          });
        }
      }

      const failures = results.filter((r) => r.exitCode !== 0).length;
      const summary = failures > 0
        ? `❌ System Prompt failed (${failures} command issue(s))`
        : "✅ System Prompt loaded.";

      const blocks = results.map(formatCommandResult).join("\n\n---\n\n");
      const fileContent = `${summary}

Config source: ${cachedConfig.path}
Prompt file detected: ${filePath}

Captured deferred file-command run:

${blocks}`;

      return {
        message: {
          customType: "system-prompt-file-bootstrap",
          content: fileContent,
          display: true,
        },
      };
    }
  });
}
