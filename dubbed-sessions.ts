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

const namingPrompt = (conversation: string): string => `
Given this conversation, generate a short, descriptive session name (max 50 characters).

Requirements:
- Use kebab-case (lowercase with hyphens)
- Describe what the session is about, not just repeat the user's message
- If it's just a greeting like "howdy", use "greeting"
- Examples: "bug-fix-investigation", "code-review-session", "feature-implementation"

Conversation:
${conversation}

Respond with just the session name, nothing else.
`.trim();

export default function (pi: ExtensionAPI) {
	let hasNamed = false;

	pi.on("session_start", async () => {
		hasNamed = !!pi.getSessionName();
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (hasNamed) return;
		hasNamed = true;

		const branch = ctx.sessionManager.getBranch();
		const conversationText = buildConversationText(branch);

		if (!conversationText.trim()) {
			return;
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
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth?.ok || !auth.apiKey) {
			console.error("No auth available for session naming");
			return;
		}

		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text" as const, text: namingPrompt(conversationText) }],
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
			.slice(0, 50);

		if (name) {
			pi.setSessionName(name);
			ctx.ui.notify(`Session named: ${name}`, "info");
		}
	});
}
