import assert from "node:assert/strict";
import { test } from "node:test";
import { makeHuhExtension, lastAnswer, speechOptions, resolveSpeechEntry } from "../huh/core.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
const entry = (text, extra = {}) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra }
});

function handle() {
  const { promise, resolve } = Promise.withResolvers();
  return { done: promise, stopped: false, stop() { this.stopped = true; resolve(); } };
}

function setup({ entries = [entry("The last answer.")], config = {}, fail = false, fetchSpeech } = {}) {
  const commands = new Map();
  const events = new Map();
  const calls = [];
  const upstream = [];
  const audio = [];
  let current;
  const selected = {
    id: "chosen",
    defaultVoice: "Default",
    speak(text, options) {
      calls.push({ provider: "chosen", text, options });
      if (fail) throw new Error("Provider unavailable");
      return handle();
    },
    ...(fetchSpeech ? { fetchSpeech } : {})
  };
  const local = {
    id: "local",
    speak(text, options) {
      calls.push({ provider: "local", text, options });
      return handle();
    }
  };
  const cfg = { enabled: false, provider: "chosen", maxChars: 0, ...config };
  const speech = {
    DEFAULT_MAX_CHARS: 400,
    defaultConfigFile: () => "/fake/speak.json",
    loadConfig: file => { assert.equal(file, "/fake/speak.json"); return cfg; },
    providerPrefs: (config, id) => config.providers?.[id] ?? {},
    resolveSpeechProvider: () => selected,
    getSpeechProvider: () => local,
    assistantText: message => typeof message?.content === "string" ? message.content
      : (message?.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n"),
    distill: (text, limit) => limit ? text.slice(0, limit) : text,
    track(value) {
      current?.stop();
      current = value;
      return value;
    },
    playAudio(value) {
      audio.push(value);
      return this.track(handle());
    },
    makePiSpeakExtension: options => function original(pi) {
      assert.deepEqual(options, { configFile: "/fake/speak.json" });
      pi.registerCommand("speak", {
        description: "Original speech command",
        getArgumentCompletions: () => [{ value: "on", label: "on" }],
        handler(args) {
          upstream.push(args);
          if (["stop", "off"].includes(args)) current?.stop();
        }
      });
      pi.registerCommand("talk", { handler() {} });
      pi.registerCommand("mood", { handler() {} });
    }
  };
  const pi = {
    registerCommand: (name, options) => commands.set(name, options),
    on: (name, callback) => events.set(name, callback)
  };
  const ctx = {
    mode: "tui",
    sessionManager: { getBranch: () => entries },
    ui: { notify() { assert.fail("/huh must not add screen output"); } }
  };
  makeHuhExtension(speech)(pi);
  return {
    commands, events, calls, upstream, audio, selected, local, speech, cfg,
    current: () => current,
    run: async (args = "", context = ctx) => { await commands.get("huh").handler(args, context); await tick(); },
    speak: async args => { await commands.get("speak").handler(args, ctx); await tick(); }
  };
}

test("missing dependency produces a named load error with the install command", () => {
  assert.throws(() => resolveSpeechEntry("/nonexistent-huh-agent"), /huh requires the privateer-speak package.*pi install npm:privateer-speak/);
});

test("selects the last completed answer, not tools, aborted output, or metadata", () => {
  const answer = entry("Final answer.");
  const entries = [entry("Older."), answer, { type: "custom" },
    entry("Running tools", { stopReason: "toolUse" }),
    entry("Call", { content: [{ type: "toolCall" }] }),
    entry("Error", { stopReason: "error" }), entry("Partial", { stopReason: "aborted" }),
    { type: "message", message: { role: "user", content: "Another question" } }];
  assert.equal(lastAnswer(entries), answer.message);
  assert.equal(lastAnswer([]), undefined);
});

test("replays with speech off, leaves config unchanged, and clears upstream speech first", async () => {
  const f = setup();
  const before = structuredClone(f.cfg);
  await f.run();
  assert.deepEqual(f.calls, [{ provider: "chosen", text: "The last answer.", options: { voice: "Default" } }]);
  assert.deepEqual(f.upstream, ["stop"]);
  assert.deepEqual(f.cfg, before);
});

test("uses the configured voice, rate, model, and reading length", async () => {
  const f = setup({ config: { maxChars: 3, providers: { chosen: { voice: "Daniel", rate: 1.2, model: "tts" } } } });
  await f.run();
  assert.equal(f.calls[0].text, "The");
  assert.deepEqual(f.calls[0].options, { voice: "Daniel", rate: 1.2, model: "tts" });
  assert.deepEqual(speechOptions(f.speech, { providers: { chosen: { model: "engine", type: "openai-compatible" } } }, f.selected), { voice: "Default" });
});

test("ignores thinking and image blocks", async () => {
  const f = setup({ entries: [entry("", { content: [
    { type: "thinking", thinking: "Private thoughts" }, { type: "text", text: "Answer." }, { type: "image" }
  ] })] });
  await f.run();
  assert.equal(f.calls[0].text, "Answer.");
});

test("no answer says only huh", async () => {
  const f = setup({ entries: [] });
  await f.run();
  assert.equal(f.calls[0].text, "huh");
  assert.equal(f.calls.length, 1);
});

test("provider failure tries huh, then falls back to the local voice", async () => {
  const f = setup({ fail: true, config: { providers: { local: { voice: "Daniel" } } } });
  await f.run();
  assert.deepEqual(f.calls.map(({ provider, text }) => [provider, text]), [
    ["chosen", "The last answer."], ["chosen", "huh"], ["local", "huh"]
  ]);
  assert.deepEqual(f.calls.at(-1).options, { voice: "Daniel" });
});

test("a missing selected provider still says huh locally", async () => {
  const f = setup();
  f.speech.resolveSpeechProvider = () => undefined;
  await f.run();
  assert.deepEqual(f.calls.map(({ provider, text }) => [provider, text]), [["local", "huh"]]);
});

test("total audio failure remains silent on screen", async () => {
  const f = setup({ fail: true });
  f.local.speak = function unavailable() { throw new Error("No speakers"); };
  await f.run();
  assert.equal(f.calls.at(-1).text, "huh");
});

test("session read failure says huh", async () => {
  const f = setup();
  await f.run("", { mode: "tui", sessionManager: { getBranch() { throw new Error("No session"); } } });
  assert.equal(f.calls[0].text, "huh");
});

for (const command of ["stop", "off", "test"]) {
  test(`/speak ${command} cancels pending synthesis and cannot play stale audio`, async () => {
    const deferred = Promise.withResolvers();
    let signal;
    const f = setup({ fetchSpeech: (_text, options) => { signal = options.signal; return deferred.promise; } });
    await f.run();
    await f.speak(command);
    assert.equal(signal.aborted, true);
    deferred.resolve({ data: new Uint8Array(), format: "wav" });
    await tick();
    assert.equal(f.audio.length, 0);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.upstream, ["stop", command]);
  });
}

test("/huh stop stops audible playback", async () => {
  const f = setup();
  await f.run();
  const playing = f.current();
  await f.run("stop");
  assert.equal(playing.stopped, true);
});

test("another /huh cancels the previous fetch", async () => {
  const requests = [];
  const f = setup({ fetchSpeech: (_text, options) => {
    const deferred = Promise.withResolvers();
    requests.push({ ...deferred, signal: options.signal });
    return deferred.promise;
  } });
  await f.run();
  await f.run();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);
  requests[0].resolve({ data: new Uint8Array(), format: "wav" });
  requests[1].resolve({ data: new Uint8Array(), format: "wav" });
  await tick();
  assert.equal(f.audio.length, 1);
  await f.run("stop");
});

for (const name of ["agent_start", "session_tree", "session_shutdown"]) {
  test(`${name} stops replay`, async () => {
    const f = setup();
    await f.run();
    const playing = f.current();
    f.events.get(name)();
    assert.equal(playing.stopped, true);
  });
}

for (const mode of ["rpc", "print", "json"]) {
  test(`${mode} does not play audio or print anything`, async () => {
    const f = setup();
    await f.run("", { mode });
    assert.equal(f.calls.length, 0);
    assert.equal(f.upstream.length, 0);
  });
}

test("retains the original commands and completions", async () => {
  const f = setup();
  assert.deepEqual([...f.commands.keys()], ["speak", "talk", "mood", "huh"]);
  await f.speak("voice Daniel");
  assert.deepEqual(f.upstream, ["voice Daniel"]);
  assert.equal(f.commands.get("speak").getArgumentCompletions("")[0].value, "on");
});
