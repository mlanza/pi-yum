import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";

const execFileAsync = promisify(execFile);

type LinkResult = {
  url: string;
  status: "success" | "error" | "skipped";
  message?: string;
};

async function openUrl(url: string) {
  if (process.platform === "darwin") {
    await execFileAsync("open", [url]);
  } else if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url], { windowsHide: true });
  } else {
    await execFileAsync("xdg-open", [url]);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "open_links",
    label: "Open Links",
    description: "Open the provided URLs in the default browser.",
    promptSnippet: "Open the given URLs in the browser.",
    promptGuidelines: [
      "Use open_links when the user asks to open or review a list of URLs in their browser.",
    ],
    parameters: Type.Object({
      urls: Type.Array(Type.String({ format: "uri" }), { minItems: 1 }),
    }),
    async execute(_toolCallId, params, signal) {
      const summary: LinkResult[] = [];

      for (const url of params.urls) {
        if (signal?.aborted) {
          summary.push({
            url,
            status: "skipped",
            message: "Cancelled by user",
          });
          break;
        }

        try {
          await openUrl(url);
          summary.push({ url, status: "success" });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          summary.push({ url, status: "error", message });
        }
      }

      const successCount = summary.filter((entry) => entry.status === "success").length;
      const openCount = params.urls.length;
      const skippedCount = summary.filter((entry) => entry.status === "skipped").length;
      const failureCount = summary.filter((entry) => entry.status === "error").length;

      const content = [
        {
          type: "text",
          text:
            signal?.aborted
              ? "Opening links was cancelled."
              : `Opened ${successCount} of ${openCount} URLs in your default browser.`,
        },
      ];

      if (failureCount > 0) {
        content.push({ type: "text", text: `${failureCount} link(s) failed to open.` });
      }

      if (skippedCount > 0) {
        content.push({ type: "text", text: `${skippedCount} link(s) were skipped due to cancellation.` });
      }

      return {
        content,
        details: { results: summary },
      };
    },
  });

  pi.registerCommand("open-links", {
    description: "Prompt the agent to open the most recent batch of links using the open_links tool.",
    handler: async (_args, ctx) => {
      await pi.sendUserMessage(
        "Please take the last batch of links we discussed and open them in the browser using the open_links tool."
      );
      ctx.ui.notify("Queued a follow-up instruction for the agent.", "info");
    },
  });
}
