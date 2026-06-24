const COMMAND_NAME = "baton";


const PASS_PROMPT = (brief, extra) => {
  const base = `The following brief explains where things left off:

# Brief

${brief}

Read the brief, then continue from there.`;
  if (!extra) {
    return base;
  }
  return `${base}

Additional instructions for the new session:
${extra}`;
};

export default function (pi) {
  pi.registerCommand(COMMAND_NAME, {
    description: "Pass the brief to resume work in a fresh session",
    handler: async (args, ctx) => {
      const extra = (args ?? "").trim();
      await passBaton(extra, ctx);
    },
  });

  async function passBaton(extra, ctx) {
    await ctx.waitForIdle();
    const branch = ctx.sessionManager.getBranch();
    const lastAssistantEntry = branch.slice().reverse().find((entry) => entry?.type === "message" && entry.message?.role === "assistant");

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
          if (extra) {
            // Immediately resume the new session with the baton brief and extra instructions
            safeNotify(newCtx, "Baton passed; a new session is now continuing with the approved brief.", "info");
            await newCtx.sendUserMessage(continuationPrompt);
          } else {
            // Seed the new session with the baton brief without triggering the agent
            await newCtx.sendMessage(
              {
                customType: "baton.manual",
                content: continuationPrompt,
                display: true,
              },
              { triggerTurn: false }
            );
            safeNotify(newCtx, "Baton passed; a new session created with approved brief and awaiting your instruction.", "info");
          }
        },
      });
      if (result.cancelled) {
        throw new Error("session_creation_cancelled");
      }
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

    // Only keep actual text blocks; drop thinking/toolCall/image blocks
    const text = blocks
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    return text;
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
