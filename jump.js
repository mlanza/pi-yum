/**
 * jump.js — pi extension: restart a session with context carried forward.
 *
 * Both /jump (slash command) and jump() (LLM tool) seed a fresh session
 * with the last assistant response, then optionally dispatch the agent
 * with an addendum.
 *
 * Usage:
 *   /jump                     → new session with last response, waits for input
 *   /jump now summarize       → new session + auto-trigger with addendum
 *   tools.jump()              → same as /jump
 *   tools.jump("Continue…")   → same as /jump <addendum>
 *
 * Based on PRD: leap-prd.md (s/jump/leap)
 * Document version: 1.0.0
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ADDENDUM_LENGTH = 500;

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

/** @type {string | null} */
let debugLogPath = null;

/**
 * Lazy-init a JSONL debug log adjacent to this extension file.
 * Records each jump invocation with context for post-hoc analysis.
 *
 * @param {string} method - "command", "tool", or "jumpdebug"
 * @param {{ addendum?: string; branchLength?: number; durationMs?: number; ok?: boolean; error?: string; data?: unknown }} info
 */
async function debugLog(method, info) {
  try {
    if (!debugLogPath) {
      const __filename = fileURLToPath(import.meta.url);
      debugLogPath = join(dirname(__filename), "jump-debug.jsonl");
      // Ensure the directory exists
      await mkdir(dirname(debugLogPath), { recursive: true });
    }

    const entry = {
      t: new Date().toISOString(),
      m: method,
      a: (info.addendum ?? "").length > 0,
      al: (info.addendum ?? "").length,
      bl: info.branchLength ?? 0,
      d: info.durationMs ?? 0,
      ok: info.ok ?? true,
      e: info.error ?? null,
      // Arbitrary structured data passed via jumpdebug tool
      ...(info.data !== undefined && info.data !== null
        ? { data: info.data }
        : {}),
    };

    await appendFile(debugLogPath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Debug logging is best-effort; never crash the command.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk the branch backwards and return the most recent assistant
 * (role === "assistant") message, or null if none exists.
 *
 * @param {readonly unknown[]} branch
 * @returns {{ content: unknown; timestamp?: number } | null}
 */
function getLastAssistantMessage(branch) {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (
      entry &&
      entry.type === "message" &&
      entry.message &&
      entry.message.role === "assistant"
    ) {
      return {
        content: entry.message.content,
        timestamp: entry.message.timestamp,
      };
    }
  }
  return null;
}

/**
 * Extract plain text from an assistant message's content, which may be
 * a string or an array of content blocks (text, thinking, toolCall, etc.).
 *
 * @param {unknown} content
 * @returns {string}
 */
function assistantContentToText(content) {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }
  return String(content).trim();
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function (pi) {
  // ---- Slash command: /jump [addendum] -----------------------------------

  pi.registerCommand("jump", {
    description:
      "Restart the session with the last assistant response carried forward. " +
      "Optionally append an addendum that is immediately sent to the agent.",

    /** @param {string} args @param {import("@earendil-works/pi-coding-agent").ExtensionCommandContext} ctx */
    handler: async (args, ctx) => {
      const startTs = performance.now();
      const addendum = (args ?? "").trim();
      const truncatedAddendum = addendum.slice(0, MAX_ADDENDUM_LENGTH);

      // 1. Wait for the agent to finish if it's still working.
      if (typeof ctx.waitForIdle === "function") {
        await ctx.waitForIdle();
      }

      // 2. Find the last assistant message in the current branch.
      const branch = ctx.sessionManager.getBranch();
      const lastAssistant = getLastAssistantMessage(branch);

      if (!lastAssistant) {
        ctx.ui.notify(
          "Cannot jump: no previous assistant response found.",
          "error",
        );
        await debugLog("command", {
          addendum,
          branchLength: branch.length,
          durationMs: Math.round(performance.now() - startTs),
          ok: false,
          error: "no previous assistant response",
        });
        return;
      }

      // 3. Extract the last assistant content as plain text.
      const lastText = assistantContentToText(lastAssistant.content);

      // 4. Start a fresh session.
      //    - With addendum: auto-trigger the agent by sending the continuation
      //      prompt as a user message.
      //    - Without addendum: place the last context in the editor and wait
      //      for the user to type their input.
      let cancelled = false;
      try {
        const result = await ctx.newSession({
          parentSession: ctx.sessionManager.getSessionFile() ?? undefined,

          withSession: async (replacementCtx) => {
            if (truncatedAddendum) {
              // Auto-trigger: send context + addendum as a user message.
              const prompt = `[Carrying forward from previous session]

${lastText}

${truncatedAddendum}`;
              await replacementCtx.sendUserMessage(prompt);
            } else {
              // No addendum: seed the editor and wait for user input.
              const editorText = `[Carrying forward from previous session]

${lastText}`;
              replacementCtx.ui.setEditorText(editorText);
              replacementCtx.ui.notify(
                "Jump ready. Waiting for your input.",
                "info",
              );
            }
          },
        });

        cancelled = result.cancelled;
        if (cancelled) {
          ctx.ui.notify("Jump cancelled.", "info");
        }
      } finally {
        await debugLog("command", {
          addendum,
          branchLength: branch.length,
          durationMs: Math.round(performance.now() - startTs),
          ok: !cancelled,
        });
      }
    },
  });

  // ---- Tool: jumpdebug(message, data?) ----------------------------------
  //
  // Self-instrumentation tool the LLM can call to log arbitrary observations
  // to the debug log for post-hoc analysis.

  pi.registerTool({
    name: "jumpdebug",
    label: "Jump Debug",
    description:
      "Log arbitrary debug info to the jump extension's debug log. " +
      "Useful for self-instrumentation — call this whenever you want to " +
      "record something interesting for later analysis.",

    promptSnippet: "Log debug info to the jump extension debug log",
    promptGuidelines: [
      "Use jumpdebug to record observations, decisions, or state snapshots while working.",
      "The log is written to jump-debug.jsonl adjacent to the jump extension.",
    ],

    parameters: Type.Object({
      message: Type.String({
        description: "Description of what's being logged.",
      }),
      data: Type.Optional(
        Type.Object({}, {
          additionalProperties: true,
          description: "Optional structured data to include.",
        }),
      ),
    }),

    /**
     * @param {string} _toolCallId
     * @param {{ message: string; data?: Record<string, unknown> }} params
     * @param {AbortSignal} _signal
     * @param {(update: any) => void} _onUpdate
     * @param {import("@earendil-works/pi-coding-agent").ExtensionContext} ctx
     */
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch();

      await debugLog("jumpdebug", {
        addendum: params.message,
        branchLength: branch.length,
        ok: true,
        data: params.data ?? null,
      });

      return {
        content: [
          {
            type: "text",
            text: `Logged to debug log: ${params.message}`,
          },
        ],
        details: {},
      };
    },
  });

  // ---- Tool: jump(addendum?) --------------------------------------------

  pi.registerTool({
    name: "jump",
    label: "Jump",
    description:
      "Start a new session seeded with the last assistant response, " +
      "optionally with an addendum to guide the next turn. " +
      "Use this when you want to continue work in a fresh session " +
      "with context carried forward.",

    promptSnippet: "Start a new session carrying forward the last response",
    promptGuidelines: [
      "Use jump when the conversation is getting long and you want a fresh session seeded with the last response.",
      "Pass an addendum to immediately direct the agent in the new session (e.g., jump('Summarize the plan')).",
    ],

    parameters: Type.Object({
      addendum: Type.Optional(
        Type.String({
          description:
            "Optional guidance for the next turn (max " +
            MAX_ADDENDUM_LENGTH +
            " chars).",
        }),
      ),
    }),

    /**
     * @param {string} _toolCallId
     * @param {{ addendum?: string }} params
     * @param {AbortSignal} _signal
     * @param {(update: any) => void} _onUpdate
     * @param {import("@earendil-works/pi-coding-agent").ExtensionContext} ctx
     */
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const startTs = performance.now();

      // Validate / sanitise.
      const addendum = (params.addendum ?? "").trim().slice(
        0,
        MAX_ADDENDUM_LENGTH,
      );

      // Quick pre-flight: is there anything to jump from?
      const branch = ctx.sessionManager.getBranch();
      const lastMsg = getLastAssistantMessage(branch);
      if (!lastMsg) {
        await debugLog("tool", {
          addendum,
          branchLength: branch.length,
          durationMs: Math.round(performance.now() - startTs),
          ok: false,
          error: "no previous assistant response",
        });

        return {
          content: [
            {
              type: "text",
              text:
                "Cannot jump: no previous assistant response found in the " +
                "current session.",
            },
          ],
          details: {},
          isError: true,
        };
      }

      // Queue the /jump command as a follow-up user message so it runs
      // after the current agent turn finishes.
      pi.sendUserMessage(
        addendum ? `/jump ${addendum}` : "/jump",
        { deliverAs: "followUp" },
      );

      await debugLog("tool", {
        addendum,
        branchLength: branch.length,
        durationMs: Math.round(performance.now() - startTs),
        ok: true,
      });

      const summary = addendum
        ? `Jump queued with addendum. The session will restart carrying ` +
          `forward the last response, then process: "${addendum}".`
        : "Jump queued. The session will restart carrying forward the " +
          "last response.";

      return {
        content: [{ type: "text", text: summary }],
        details: {},
      };
    },
  });
}
