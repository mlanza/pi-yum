import process from "node:process";

/**
 * Idle notification extension for pi.
 * Shows a desktop notification and plays a sound when the agent goes idle,
 * summarizing the last assistant message.
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function (pi) {
  let lastText = null;
  let idleTimer = null;
  const IDLE_MS = 1000;

  /**
   * Extracts a Summary line or truncates the text.
   * @param {string|null} text
   */
  function getIdleSummary(text) {
    if (!text) return;
    const idleMatch = text.match(/[_*]Summary:[_*]? (.*)[_*]?$/m);
    if (idleMatch && idleMatch[1]) {
      return idleMatch[1].trim();
    }
    if (text.length > 80) {
      return text.slice(0, 80) + "...";
    }
    return text;
  }

  /**
   * Plays a sound and displays a notification with the summary.
   */
  async function notifyIdle() {
    const summary = getIdleSummary(lastText) ?? "Idle";

    if (process.platform === "darwin") {
      await pi.exec("osascript", [
        "-e",
        'do shell script "afplay /System/Library/Sounds/Frog.aiff"',
      ]);
      await pi.exec("osascript", [
        "-e",
        `display notification ${JSON.stringify(summary)} with title "pi"`,
      ]);
    } else {
      await pi.exec("canberra-gtk-play", ["--id=message"]);
      await pi.exec("notify-send", ["pi", summary]);
    }
  }

  // Reset the idle timer on each assistant message update
  pi.on("message_update", ({ message }) => {
    if (message.role !== "assistant") return;
    const segments = message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    lastText = segments.join("");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      notifyIdle().catch(() => {});
    }, IDLE_MS);
  });

  // Clean up timer on session end
  pi.on("session_shutdown", () => {
    clearTimeout(idleTimer);
  });
}
