import { Type } from "typebox";
import process from "node:process";

/**
 * Pi extension to provide clipboard read/write tools.
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function (pi) {
  pi.registerTool({
    name: "clipboard_write",
    label: "Clipboard Write",
    description: "Write text to the system clipboard",
    promptSnippet: "Write text to the system clipboard",
    promptGuidelines: [
      "Use clipboard_write when copying text to the user's clipboard."
    ],
    parameters: Type.Object({
      text: Type.String({ description: "The text to write to the clipboard" }),
    }),
    async execute(_toolCallId, params, signal) {
      const text = params.text;
      // Escape backslashes and double quotes
      const escaped = text.replace(/\\/g, "\\\\").replace(/\"/g, '\\"');
      let cmd;

      if (process.platform === "darwin") {
        cmd = ["sh", ["-c", `echo \"${escaped}\" | pbcopy`]];
      } else if (process.platform === "win32") {
        cmd = ["sh", ["-c", `echo ${escaped} | clip`]];
      } else {
        // Linux: try xclip, then xsel
        try {
          await pi.exec("which", ["xclip"], { signal });
          cmd = ["sh", ["-c", `echo \"${escaped}\" | xclip -selection clipboard`]];
        } catch {
          try {
            await pi.exec("which", ["xsel"], { signal });
            cmd = ["sh", ["-c", `echo \"${escaped}\" | xsel --clipboard --input`]];
          } catch {
            return {
              content: [
                { type: "text", text: "Error: No clipboard utility found. Please install xclip or xsel on Linux." }
              ],
              details: { success: false, text, error: "No clipboard utility found. Please install xclip or xsel on Linux." },
              isError: true,
            };
          }
        }
      }

      try {
        await pi.exec(cmd[0], cmd[1], { signal });
        return {
          content: [
            { type: "text", text: "Text copied to clipboard successfully" }
          ],
          details: { success: true, text, message: "Text copied to clipboard successfully" },
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `Error copying to clipboard: ${error}` }
          ],
          details: { success: false, text, error },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "clipboard_read",
    label: "Clipboard Read",
    description: "Read text from the system clipboard",
    promptSnippet: "Read text from the system clipboard",
    promptGuidelines: [
      "Use clipboard_read when the user requests the current clipboard contents."
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      let cmd;

      if (process.platform === "darwin") {
        cmd = ["pbpaste", []];
      } else if (process.platform === "win32") {
        cmd = ["powershell", ["-command", "Get-Clipboard"]];
      } else {
        try {
          await pi.exec("which", ["xclip"], { signal });
          cmd = ["xclip", ["-selection", "clipboard", "-o"]];
        } catch {
          try {
            await pi.exec("which", ["xsel"], { signal });
            cmd = ["xsel", ["--clipboard", "--output"]];
          } catch {
            return {
              content: [
                { type: "text", text: "Error: No clipboard utility found. Please install xclip or xsel on Linux." }
              ],
              details: { success: false, error: "No clipboard utility found. Please install xclip or xsel on Linux." },
              isError: true,
            };
          }
        }
      }

      try {
        const result = await pi.exec(cmd[0], cmd[1], { signal });
        const output = result.stdout.trim();
        return {
          content: [{ type: "text", text: output }],
          details: { success: true, text: output, message: "Text read from clipboard successfully" },
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `Error reading from clipboard: ${error}` }
          ],
          details: { success: false, error },
          isError: true,
        };
      }
    },
  });
}
