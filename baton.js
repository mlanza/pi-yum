const COMMAND_NAME = "baton";
const USAGE = [
  "Usage:",
  "  /baton make [extra instructions]",
  "  /baton pass [extra instructions]",
].join("\n");

const MAKE_PROMPT = (extra) => `Create a concise handoff brief for continuing this work in a fresh session.

Include:
- current goal
- current stage
- decisions made
- completed work
- remaining work
- useful files, commands, links, or deliverables
- validation already performed
- known risks or open questions
- recommended next action

Additional user instructions:
${extra}

Write the brief so another session can resume without rediscovering completed work.`;

const PASS_PROMPT = (brief, extra) => {
  const base = `We are resuming where we left off, from this approved baton brief:

${brief}

Read the brief, identify the current stage and next unfinished action, then continue from there without rediscovering completed work. Do not repeat completed work unless validation requires it. If the brief is incomplete, state the missing information briefly and proceed with the safest next step.`;
  if (!extra) {
    return base;
  }
  return `${base}

Additional user instructions for the new session:
${extra}`;
};

export default function (pi) {
  pi.registerCommand(COMMAND_NAME, {
    description: "Create or pass a baton brief to resume work in a fresh session",
    handler: async (args, ctx) => {
      const input = (args ?? "").trim();
      if (!input) {
        return notifyUsage(ctx);
      }

      const firstSpace = input.indexOf(" ");
      const subcommand = firstSpace === -1 ? input : input.slice(0, firstSpace);
      const extra = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();
      const verb = subcommand.toLowerCase();

      if (verb === "make") {
        await requestBatonBrief(extra, ctx);
        return;
      }

      if (verb === "pass") {
        await passBaton(extra, ctx);
        return;
      }

      notifyUsage(ctx);
    },
  });

  function notifyUsage(ctx) {
    safeNotify(ctx, USAGE, "warning");
  }

  async function requestBatonBrief(extra, ctx) {
    const instructions = extra.trim() || "None.";
    const prompt = MAKE_PROMPT(instructions);
    safeNotify(ctx, "Queuing baton brief request...", "info");
    await pi.sendUserMessage(prompt);
  }

  async function passBaton(extra, ctx) {
    await ctx.waitForIdle();
    const branch = ctx.sessionManager.getBranch();
    const lastAssistantEntry = branch.find((entry) => entry?.type === "message" && entry.message?.role === "assistant");

    if (!lastAssistantEntry) {
      safeNotify(ctx, "No assistant response available to pass as a baton.", "error");
      return;
    }

    const brief = assistantMessageToText(lastAssistantEntry.message);
    if (!brief) {
      safeNotify(ctx, "The last assistant response was empty; cannot pass the baton.", "error");
      return;
    }

    const continuationPrompt = PASS_PROMPT(brief, extra);

    try {
      const result = await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        withSession: async (newCtx) => {
          await newCtx.sendUserMessage(continuationPrompt);
        },
      });

      if (result.cancelled) {
        throw new Error("session_creation_cancelled");
      }

      safeNotify(ctx, "Baton passed; a new session is now continuing with the approved brief.", "info");
    } catch (error) {
      await shareManualContinuation(continuationPrompt, ctx);
    }
  }

  function assistantMessageToText(message) {
    if (!message) {
      return "";
    }

    const blocks = Array.isArray(message.content)
      ? message.content
      : typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : [];

    const text = blocks
      .map((block) => {
        if (!block) return "";
        switch (block.type) {
          case "text":
            return block.text;
          case "thinking":
            return `[thinking: ${block.thinking}]`;
          case "toolCall":
            return `[tool call ${block.name}: ${JSON.stringify(block.arguments ?? {})}]`;
          case "image":
            return `[image ${block.mimeType ?? "unknown"}]`;
          default:
            return `[${block.type}]`;
        }
      })
      .filter(Boolean)
      .join("\n");

    return text.trim();
  }

  async function shareManualContinuation(prompt, ctx) {
    const manualMessage = [
      "Unable to start a new session automatically.",
      "Use the continuation prompt below to resume in a fresh session.",
      "",
      prompt,
    ].join("\n");

    await pi.sendMessage(
      {
        customType: "baton.manual",
        content: manualMessage,
        display: true,
      },
      {
        triggerTurn: true,
      }
    );

    safeNotify(ctx, "Manual continuation prompt provided; copy it into a new session to proceed.", "warning");
  }

  function safeNotify(ctx, message, level = "info") {
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.notify(message, level);
  }
}
