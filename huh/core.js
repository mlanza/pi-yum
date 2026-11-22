import { createRequire } from "node:module";
import { join } from "node:path";

// Resolve Pi's installed dependency, rather than installing another speech package.
export function resolveSpeechEntry(agentDir) {
  const require = createRequire(join(agentDir, "npm", "package.json"));
  let entry;
  try {
    entry = require.resolve("privateer-speak");
  } catch (cause) {
    throw new Error("huh requires the privateer-speak package. Install it with: pi install npm:privateer-speak", { cause });
  }
  return entry;
}

export function lastAnswer(entries) {
  return entries.findLast(isAnswer)?.message;
}

function isAnswer(entry) {
  const message = entry?.type === "message" ? entry.message : undefined;
  return message?.role === "assistant"
    && !["toolUse", "error", "aborted"].includes(message.stopReason)
    && !message.content?.some?.(isToolCall);
}

const isToolCall = block => block?.type === "toolCall";

export function speechOptions(speech, config, provider) {
  const prefs = speech.providerPrefs(config, provider.id);
  const voice = prefs.voice ?? provider.defaultVoice;
  return {
    ...(voice ? { voice } : {}),
    ...(prefs.rate ? { rate: prefs.rate } : {}),
    ...(prefs.model && !prefs.type ? { model: prefs.model } : {})
  };
}

export function makeHuhExtension(speech, { configFile = speech.defaultConfigFile() } = {}) {
  return function huhExtension(pi) {
    let replay;
    let speechCommand;

    function cancelReplay() {
      replay?.controller.abort();
      replay?.handle?.stop();
      replay = undefined;
    }

    // Load upstream once, in this module scope, so both commands share its registry.
    speech.makePiSpeakExtension({ configFile })({
      ...pi,
      registerCommand(name, options) {
        if (name !== "speak") return pi.registerCommand(name, options);
        speechCommand = options;
        return pi.registerCommand(name, {
          ...options,
          async handler(args, ctx) {
            const sub = args.trim().split(/\s+/)[0].toLowerCase();
            if (["stop", "off", "test"].includes(sub)) cancelReplay();
            return options.handler(args, ctx);
          }
        });
      }
    });

    async function say(text, config, provider, job) {
      if (!text || !provider) throw new Error("Nothing to speak.");
      const options = speechOptions(speech, config, provider);
      if (provider.fetchSpeech) {
        const audio = await provider.fetchSpeech(text, { ...options, signal: job.controller.signal });
        if (job.controller.signal.aborted) return;
        job.handle = speech.playAudio(audio);
      } else if (provider.speak) {
        job.handle = speech.track(provider.speak(text, options));
      } else {
        throw new Error("The selected provider cannot speak.");
      }
      await job.handle.done;
    }

    async function failure(config, provider, job) {
      const local = speech.getSpeechProvider("local");
      for (const candidate of [...new Set([provider, local].filter(Boolean))]) {
        if (job.controller.signal.aborted) return;
        try {
          await say("huh", config, candidate, job);
          return;
        } catch {
          // No screen output, even when no working audio provider remains.
        }
      }
    }

    async function play(text, job) {
      let config = {};
      let provider;
      try {
        config = speech.loadConfig(configFile);
        provider = speech.resolveSpeechProvider(config.provider);
        const utterance = speech.distill(text, config.maxChars ?? speech.DEFAULT_MAX_CHARS);
        await say(utterance, config, provider, job);
      } catch {
        if (!job.controller.signal.aborted) await failure(config, provider, job);
      } finally {
        if (replay === job) replay = undefined;
      }
    }

    pi.registerCommand("huh", {
      description: "Read the latest answer using privateer-speak; /huh stop cancels replay",
      getArgumentCompletions: prefix => "stop".startsWith(prefix)
        ? [{ value: "stop", label: "stop", description: "Stop replay" }]
        : null,
      async handler(args, ctx) {
        if (args.trim().toLowerCase() === "stop") return cancelReplay();
        if (ctx.mode !== "tui") return;

        cancelReplay();
        const job = { controller: new AbortController() };
        replay = job;
        let text = "";
        try {
          if (!args.trim()) text = speech.assistantText(lastAnswer(ctx.sessionManager.getBranch()));
          // Clear upstream's queue as well as its current playback before replaying.
          await speechCommand.handler("stop", ctx);
        } catch {
          // An unreadable session is handled by the same spoken fallback.
        }
        if (job.controller.signal.aborted) return;
        // Return promptly so /huh stop and /speak stop remain usable during synthesis.
        void play(text, job);
      }
    });

    pi.on("agent_start", cancelReplay);
    pi.on("session_tree", cancelReplay);
    pi.on("session_shutdown", cancelReplay);
  };
}

