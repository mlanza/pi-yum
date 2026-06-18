let toolsFrozen = false;

export default function(pi) {

  function render(ctx) {
    if (ctx.hasUI) {
      const statusText = `${ toolsFrozen ? "🧠 Plan" : "⚡ Act"} ${ctx.ui.theme.fg("dim", !toolsFrozen ? "(F7=Plan)" : "(F8=Act)")}`;
      ctx.ui.setStatus("freeze-tools", statusText, {
        minimal: true
      });
    }
  }

  pi.registerShortcut("f7", { //if you notice an agent doing something peculiar, this is your emergency kill switch
    description: "Select Plan Mode",
    handler: (ctx) => {
      toolsFrozen = true;
      render(ctx);
    },
  });

  pi.registerShortcut("f8", {
    description: "Select Act Mode",
    handler: (ctx) => {
      toolsFrozen = false;
      render(ctx);
    },
  });


  pi.on("ready", (ctx) => {
    render(ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    render(ctx);
  });

  // Hide tools from the model before planning begins
  pi.on("context_build", async (event) => {
    if (!toolsFrozen) return;

    // Remove all tools from model-visible context
    event.tools = [];

    // Add behavioral guidance directly into context
    event.systemMessages = [
      ...(event.systemMessages || []),
      `
Plan Mode.

Tool use is currently disabled.
Do not attempt tool calls.
Do not retry tool calls.
Do not look for workarounds.

In this mode:
- discuss ideas
- formulate plans (which may involve tools once enabled)
- explain approaches
- prepare conceptual changes only

When it comes time to act, the user will enable tool use.
`
    ];
  });

  // Safety net in case a tool slips through anyway
  pi.on("tool_call", async () => {
    if (!toolsFrozen) return;

    return {
      block: true,
      reason: `In Plan Mode tool use is disabled.  Discuss the approach conversationally instead.`
    };
  });
}
