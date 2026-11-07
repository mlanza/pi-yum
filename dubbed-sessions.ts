/**
 * Dubbed Sessions
 *
 * Names sessions by analyzing the conversation with an LLM call.
 */

import { complete, getModel } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type SessionEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

const extractTextParts = (content: unknown): string => {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	const textParts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		}
	}

	return textParts.join("\n");
};

const buildConversationText = (entries: SessionEntry[]): string => {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;

		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;

		const text = extractTextParts(entry.message.content);
		if (text.trim()) {
			sections.push(`${role}: ${text}`);
		}
	}

	return sections.join("\n\n");
};

const namingPrompt = (conversation: string, mode: "initial" | "full"): string => `
Given this conversation, generate a short, descriptive session name (max 50 characters).

Requirements:
- Use normal headline/subject-line style text (not kebab-case)
- Use natural capitalization (e.g., "Investigate Login Redirect Bug")
- Describe what the session is about, not just repeat the user's message
- If it's just a greeting like "howdy", use "Greeting"
- Examples: "Bug Fix Investigation", "Code Review Session", "Feature Implementation"
${mode === "full" ? "- Base the name on the full arc of the conversation so far, including where it ended up" : "- Base the name on the first turn's apparent intent"}

Conversation:
${conversation}

Respond with just the session name, nothing else.
`.trim();

export default function (pi: ExtensionAPI) {
	let hasNamed = false;

	const dubSession = async (ctx: any, mode: "initial" | "full") => {
		const branch = ctx.sessionManager.getBranch();
		const conversationText = buildConversationText(branch);

		if (!conversationText.trim()) {
			ctx.ui.notify("No conversation yet to name", "warning");
			return false;
		}

		const currentModel = ctx.model;
		let model = currentModel
			? getModel(currentModel.provider, currentModel.id)
			: undefined;

		if (!model) {
			model = getModel("anthropic", "haiku");
		}
		if (!model) {
			model = getModel("openai", "gpt-4o-mini");
		}

		if (!model) {
			console.error("No model available for session naming");
			ctx.ui.notify("No model available for session naming", "error");
			return false;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth?.ok || !auth.apiKey) {
			console.error("No auth available for session naming");
			ctx.ui.notify("No auth available for session naming", "error");
			return false;
		}

		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text" as const, text: namingPrompt(conversationText, mode) }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
			},
		);

		const name = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text.trim())
			.join("")
			.replace(/^['"`]|['"`]$/g, "")
			.replace(/\s+/g, " ")
			.slice(0, 50)
			.trim();

		if (!name) {
			ctx.ui.notify("Could not generate a session name", "warning");
			return false;
		}

		pi.setSessionName(name);
		hasNamed = true;
		pi.sendMessage({
			customType: "dubbed-sessions",
			content: `Session renamed to: ${name}`,
			display: true,
			details: { mode, timestamp: Date.now() },
		});
		return true;
	};

	pi.on("session_start", async () => {
		hasNamed = !!pi.getSessionName();
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (hasNamed) return;
		await dubSession(ctx, "initial");
	});

	pi.registerCommand("dub", {
		description: "Regenerate session name from the full conversation",
		handler: async (_args, ctx) => {
			await dubSession(ctx, "full");
		},
	});
}
