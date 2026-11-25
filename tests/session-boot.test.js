import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import test from "node:test";

const source = (await readFile(new URL("../session-boot.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "")
  .replace("export default function", "function");
const executeFile = promisify(execFile);
const passkey = "test-secret";

function loadExtension(home = "/unused", argv = ["node", "test"], env = {}) {
  const context = vm.createContext({
    access, readFile, writeFile, fsConstants, createHash, path,
    os: { homedir: () => home },
    process: { env: { SESSIONBOOT_PASSKEY: passkey, ...env }, argv },
    AbortController, setTimeout, clearTimeout,
  });
  vm.runInContext(source, context);
  return context;
}

const helpers = loadExtension();

function signed(body) {
  const unsigned = helpers.readRC(helpers.serializeRC(body, "00000000"), passkey);
  return helpers.serializeRC(body, unsigned.hashkey);
}

test("checksums are recognized at the beginning, middle, or end", function () {
  const body = "#!/usr/bin/env bash\necho hello\n";
  const checksum = helpers.makeHashkey(passkey, body);
  const comment = `#checksum: ${checksum}\n`;
  const scripts = [comment + body, body.replace("echo", comment + "echo"), body + comment];
  for (const raw of scripts) {
    const rc = helpers.readRC(raw, passkey);
    assert.equal(rc.checksum, checksum);
    assert.equal(rc.body, body);
    assert.equal(rc.safe, true);
    assert.equal(helpers.formatScriptSection(raw), body);
  }
});

test("grant preserves shebangs, line endings, and empty files", function () {
  const bodies = [
    "echo hello", "", "#!/usr/bin/env bash", "#!/usr/bin/env bash\n",
    "#!/usr/bin/env bash\necho hello\n\n",
    "#!/usr/bin/env bash\r\necho hello\r\n",
  ];
  for (const body of bodies) {
    const raw = signed(body);
    assert.equal(helpers.readRC(raw, passkey).safe, true);
    assert.equal(signed(helpers.readRC(raw, passkey).body), raw);
    if (body.startsWith("#!")) {
      assert.equal(raw.split(/\r?\n/)[0], body.split(/\r?\n/)[0]);
      assert.match(raw.split(/\r?\n/)[1], /^#checksum: [A-Za-z0-9]{8}$/);
    }
    const expected = body.startsWith("#!") && !body.includes("\n") ? `${body}\n` : body;
    assert.equal(helpers.readRC(raw, passkey).body, expected);
  }
});

test("grant replaces existing checksums in place and removes duplicate markers", function () {
  const scripts = [
    "#checksum: QLNaFq32\necho hello\n",
    "#!/usr/bin/env bash\necho hello\n#checksum: QLNaFq32\necho goodbye\n",
    "echo hello\n#checksum: QLNaFq32",
    "#!/usr/bin/env bash\r\necho hello\r\n#checksum: QLNaFq32\r\necho goodbye\r\n",
  ];
  for (const raw of scripts) {
    const updated = signed(raw);
    const rc = helpers.readRC(updated, passkey);
    assert.equal(rc.safe, true);
    assert.equal(updated, raw.replace("QLNaFq32", rc.hashkey));
    assert.equal(signed(updated), updated);
    assert.equal(helpers.serializeRC(updated, ""), helpers.readRC(raw, passkey).body);
  }
  const duplicate = "echo hello\n#checksum: QLNaFq32\necho goodbye\n#checksum: ABCD1234\n";
  const updated = signed(duplicate);
  assert.equal(helpers.readRC(updated, passkey).safe, true);
  assert.equal(updated.split("#checksum: ").length, 2);
  assert.ok(updated.startsWith("echo hello\n#checksum: "));
});

test("missing, malformed, duplicate, legacy, and tampered checksums fail closed", function () {
  const raw = signed("echo hello\n");
  const invalid = [
    "echo hello\n", "#checksum: short\necho hello\n", "@QLNaFq32\necho hello\n",
    `echo '#checksum: QLNaFq32'\n`, `${raw}#checksum: QLNaFq32\n`,
    raw.replace("hello", "changed"),
  ];
  for (const script of invalid) assert.equal(helpers.readRC(script, passkey).safe, false);
  assert.equal(helpers.readRC(raw, "wrong-secret").safe, false);
  assert.equal(helpers.readRC(raw, "").safe, false);
});

test("grant, bootstrap, and revoke use the full Bash file", async function () {
  const home = await mkdtemp(path.join(os.tmpdir(), "session-boot-test-"));
  try {
    const extension = loadExtension(home);
    const commands = new Map();
    const events = new Map();
    const messages = [];
    const executions = [];
    const notices = [];
    const entries = [];
    const pi = {
      registerFlag() {},
      getFlag: (name) => name === "sessionboot-samples",
      registerMessageRenderer() {},
      registerEntryRenderer() {},
      appendEntry: (type, data) => entries.push({ type, data, messagesSoFar: messages.length }),
      registerCommand: (name, command) => commands.set(name, command),
      on: (name, handler) => events.set(name, handler),
      sendMessage: (message) => messages.push(message),
      async exec(command, args, options) {
        executions.push({ command, args });
        try {
          const result = await executeFile(command, args, options);
          return { ...result, code: 0, killed: false, truncated: false };
        } catch (error) {
          if (typeof error.code !== "number") throw error;
          return { stdout: error.stdout, stderr: error.stderr, code: error.code,
            killed: false, truncated: false };
        }
      },
    };
    extension.sessionBootExtension(pi);
    const ctx = { cwd: home, ui: { notify: (message) => notices.push(message) } };
    const file = path.join(home, ".sessionbootrc");
    const body = "#!/usr/bin/env bash\nvalues=(hello bash)\nprintf '%s\\n' \"${values[*]}\"\n\n";
    await writeFile(file, body);
    const handler = commands.get("session-boot").handler;
    await handler("grant --local", ctx);
    const raw = await readFile(file, "utf8");
    assert.equal(extension.readRC(raw, passkey).safe, true);
    assert.ok(raw.startsWith("#!/usr/bin/env bash\n#checksum: "));
    await handler("grant --local", ctx);
    assert.equal(await readFile(file, "utf8"), raw);

    // Grant always refreshes an existing marker, without moving it.
    const middle = body.replace("printf", "#checksum: QLNaFq32\nprintf");
    await writeFile(file, middle);
    await handler("grant --local", ctx);
    const refreshed = await readFile(file, "utf8");
    assert.equal(extension.readRC(refreshed, passkey).safe, true);
    assert.equal(refreshed, middle.replace("QLNaFq32", extension.readRC(refreshed, passkey).hashkey));
    await writeFile(file, raw);

    await events.get("session_start")({ reason: "new" }, ctx);
    assert.equal(executions.length, 1);
    assert.equal(entries.length, 10);
    assert.deepEqual(entries.map((entry) => entry.data.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(entries.every((entry) => entry.messagesSoFar === 0));
    assert.equal(executions[0].command, "bash");
    assert.equal(executions[0].args[1], raw);
    assert.ok(!messages[0].content.includes("↓↓↓"));
    assert.ok(!messages[0].content.includes("#!/usr/bin/env bash"));
    assert.ok(!messages[0].content.includes("#checksum: "));
    assert.equal(await readFile(file, "utf8"), raw);
    assert.ok(messages[0].content.includes("hello bash"));
    assert.ok(messages[0].content.startsWith("✅ "));

    // pi.exec resolves nonzero exits with `code`; it does not throw.
    const failureBody = "#!/usr/bin/env bash\nprintf 'server unavailable\\n' >&2\nexit 7\n";
    await writeFile(file, signed(failureBody));
    await events.get("session_start")({ reason: "new" }, ctx);
    assert.ok(messages.at(-1).content.startsWith("❌ "));
    assert.ok(messages.at(-1).content.includes("exit code 7"));
    assert.ok(messages.at(-1).content.includes("↓↓↓\n\nserver unavailable"));
    executions.pop();
    await writeFile(file, raw);

    // Change an executable line, rather than the trust marker.
    await writeFile(file, raw.replace("values=(hello bash)", "values=(changed bash)"));
    await events.get("session_start")({ reason: "new" }, ctx);
    assert.equal(executions.length, 1);
    assert.ok(messages.at(-1).content.includes("Checksum mismatch"));
    assert.ok(!messages.at(-1).content.includes("#checksum: "));
    assert.ok(messages.at(-1).content.includes("values=(changed bash)"));

    extension.process.env.SESSIONBOOT_PASSKEY = "";
    await events.get("session_start")({ reason: "new" }, ctx);
    assert.equal(executions.length, 1);
    assert.ok(messages.at(-1).content.includes("Missing SESSIONBOOT_PASSKEY"));
    assert.ok(!messages.at(-1).content.includes("#checksum: "));
    extension.process.env.SESSIONBOOT_PASSKEY = passkey;

    await writeFile(file, raw);
    await handler("revoke --local", ctx);
    assert.equal(await readFile(file, "utf8"), body);
    pi.getFlag = () => false;
    const sampleCount = entries.length;
    await events.get("session_start")({ reason: "new" }, ctx);
    assert.equal(entries.length, sampleCount);
    assert.equal(executions.length, 1);
    assert.ok(messages.at(-1).content.includes("Missing or duplicate checksum"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("show rc env var forces the script block on success", async function () {
  const home = await mkdtemp(path.join(os.tmpdir(), "session-boot-test-"));
  try {
    const extension = loadExtension(home, ["node", "test"], { SESSIONBOOT_SHOW_RC: "1" });
    const events = new Map();
    const messages = [];
    const executions = [];
    const pi = {
      registerFlag() {},
      getFlag: () => false,
      registerMessageRenderer() {},
      registerEntryRenderer() {},
      appendEntry() {},
      registerCommand() {},
      on: (name, handler) => events.set(name, handler),
      sendMessage: (message) => messages.push(message),
      async exec(command, args, options) {
        executions.push({ command, args });
        const result = await executeFile(command, args, options);
        return { ...result, exitCode: 0 };
      },
    };
    extension.sessionBootExtension(pi);
    const ctx = { cwd: home, ui: { notify() {} } };
    const file = path.join(home, ".sessionbootrc");
    const raw = signed("#!/usr/bin/env bash\necho hello\n");
    await writeFile(file, raw);
    await events.get("session_start")({ reason: "new" }, ctx);
    assert.equal(executions.length, 1);
    assert.ok(messages[0].content.includes("#!/usr/bin/env bash"));
    assert.ok(messages[0].content.includes("↓↓↓"));
    assert.ok(messages[0].content.includes("hello"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
