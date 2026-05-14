const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");

// === CONFIGURATION ===

const soundPolicies = {
  systemSound: {
    mode: "systemSound",
    // macOS system sounds live under /System/Library/Sounds/*.aiff.
    // Pick whichever one feels right (Glass, Funk, Pop, etc.).
    soundName: "Glass",
  },
  customAudio: {
    mode: "customAudio",
    // You can point this to a local .wav/.aiff/.mp3 or even an https URL.
    source: "https://mlanza.com/audio/Tink.wav",
  },
  terminalBell: {
    mode: "terminalBell",
  },
};

const config = {
  soundPolicy: soundPolicies.systemSound, // swap to soundPolicies.customAudio or .terminalBell as desired
  dingEvents: ["idle"], // name the events you want to hear a ding for ("idle", "turn_end", "agent_end", etc.)
  idle: {
    pauseMs: 1800, // how long without work before we call the idle event
  },
  notificationBubble: {
    enabled: false,
    title: "Pi Idle",
    body: "Ready for input",
  },
};

// === NOTIFICATION HELPERS ===

function windowsToastScript(title, body) {
  const type = "Windows.UI.Notifications";
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  return [
    `${mgr} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
  ].join("; ");
}

function notifyOSC777(title, body) {
  process.stdout.write(`\u001b]777;notify;${title};${body}\u0007`);
}

function notifyOSC99(title, body) {
  process.stdout.write(`\u001b]99;i=1:d=0;${title}\u001b\\`);
  process.stdout.write(`\u001b]99;i=1:p=body;${body}\u001b\\`);
}

function notifyWindows(title, body) {
  spawn("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)], {
    stdio: "ignore",
  }).once("error", () => {});
}

function notifyBubble(title, body) {
  if (process.env.WT_SESSION) {
    notifyWindows(title, body);
  } else if (process.env.KITTY_WINDOW_ID) {
    notifyOSC99(title, body);
  } else {
    notifyOSC777(title, body);
  }
}

// === SOUND PLAYBACK ===

const systemSoundDir = "/System/Library/Sounds";
let customAudioCache = { source: null, localPath: null };

function runPlayer(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}

async function playSystemSound(soundName) {
  if (process.platform !== "darwin") {
    process.stdout.write("\u0007");
    return;
  }

  const candidate = path.join(systemSoundDir, `${soundName}.aiff`);
  try {
    await runPlayer("afplay", [candidate]);
  } catch (error) {
    console.warn("ding-dong: failed to play system sound", error);
    process.stdout.write("\u0007");
  }
}

async function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const destination = path.join(os.tmpdir(), `ding-dong-${Date.now()}-${Math.random().toString(36).slice(2)}.audio`);
    const writer = fs.createWriteStream(destination);
    const client = url.startsWith("https") ? https : http;
    const request = client.get(url, (response) => {
      if (response.statusCode !== 200) {
        writer.close();
        fs.unlink(destination, () => {});
        return reject(new Error(`Download failed: ${response.statusCode}`));
      }
      response.pipe(writer);
    });

    request.once("error", (error) => {
      writer.close();
      fs.unlink(destination, () => {});
      reject(error);
    });

    writer.once("finish", () => resolve(destination));
    writer.once("error", (error) => {
      writer.close();
      fs.unlink(destination, () => {});
      reject(error);
    });
  });
}

async function resolveCustomSource(source) {
  if (!source) return null;
  const isHttp = source.startsWith("http://") || source.startsWith("https://");
  if (!isHttp) return source;

  if (customAudioCache.source === source && fs.existsSync(customAudioCache.localPath)) {
    return customAudioCache.localPath;
  }

  const downloaded = await downloadToTemp(source);
  if (customAudioCache.localPath && customAudioCache.source !== source) {
    fsPromises.unlink(customAudioCache.localPath).catch(() => {});
  }

  customAudioCache = { source, localPath: downloaded };
  return downloaded;
}

async function playCustomAudio(source) {
  if (!source) return;
  try {
    const filePath = await resolveCustomSource(source);
    if (!filePath) return;

    if (process.platform === "darwin") {
      await runPlayer("afplay", [filePath]);
      return;
    }

    if (process.platform === "linux") {
      await runPlayer("paplay", [filePath]);
      return;
    }

    if (process.platform === "win32") {
      const cmd = `(New-Object Media.SoundPlayer '${filePath}').PlaySync()`;
      await runPlayer("powershell.exe", ["-NoProfile", "-Command", cmd]);
      return;
    }

    process.stdout.write("\u0007");
  } catch (error) {
    console.warn("ding-dong: failed to play custom audio", error);
    process.stdout.write("\u0007");
  }
}

async function playSound() {
  const { soundPolicy } = config;
  switch (soundPolicy.mode) {
    case "customAudio":
      await playCustomAudio(soundPolicy.source);
      break;
    case "systemSound":
      await playSystemSound(soundPolicy.soundName);
      break;
    case "terminalBell":
    default:
      process.stdout.write("\u0007");
      break;
  }
}

// === DING EVENT MODEL ===

function shouldDing(eventName) {
  return config.dingEvents.includes(eventName);
}

async function ring(eventName) {
  if (!shouldDing(eventName)) return;
  await playSound().catch((error) => console.warn("ding-dong: sound error", error));
  if (config.notificationBubble.enabled) {
    notifyBubble(config.notificationBubble.title, config.notificationBubble.body);
  }
}

// === EXTENSION ENTRY POINT ===

module.exports = function dingDong(pi) {
  let idleTimer;
  let lastCtx;

  const delay = Math.max(0, config.idle.pauseMs || 1000);

    const canFireIdle = (ctx) => {
    if (!ctx) return false;
    if (!ctx.isIdle()) return false;
    if (ctx.hasPendingMessages()) return false;
    return true;
  };

  const scheduleIdle = () => {
    if (!shouldDing("idle") || !lastCtx) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!canFireIdle(lastCtx)) {
        scheduleIdle();
        return;
      }
      ring("idle", lastCtx);
    }, delay);
  };

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  pi.on("agent_start", () => {
    clearIdleTimer();
  });

  pi.on("turn_end", (_event, ctx) => {
    lastCtx = ctx;
    if (shouldDing("turn_end")) {
      ring("turn_end", ctx);
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    lastCtx = ctx;
    if (shouldDing("agent_end")) {
      ring("agent_end", ctx);
    }
    scheduleIdle();
  });

  pi.on("session_shutdown", () => {
    clearIdleTimer();
    customAudioCache = { source: null, localPath: null };
  });
};
