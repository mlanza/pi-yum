let toolsFrozen = false;

export default function(pi) {

  function render(ctx) {
    if (!ctx.hasUI) return;

    ctx.ui.setStatus(
      "freeze-tools",
      toolsFrozen
        ? "🧠 PLAN"
        : "⚡ ACT",
      {
        minimal: true
      }
    );
  }

  pi.registerShortcut("f8", {
    description: "Toggle planning mode",

    handler: async (ctx) => {
      toolsFrozen = !toolsFrozen;
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
PLANNING MODE ACTIVE.

You cannot currently take actions or use tools.

Do not attempt tool calls.
Do not retry tool calls.
Do not search for alternate tools.

In this mode:
- discuss ideas
- formulate plans
- explain approaches
- prepare conceptual changes only

If execution is required, ask the user to re-enable action mode.
`
    ];
  });

  // Safety net in case a tool slips through anyway
  pi.on("tool_call", async () => {
    if (!toolsFrozen) return;

    return {
      block: true,

      reason: `
PLANNING MODE ACTIVE.

Tool usage is currently disabled.

Discuss the approach conversationally instead.
`
    };
  });
}
