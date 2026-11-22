import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { makeHuhExtension, resolveSpeechEntry } from "./huh/core.js";

export default async function huh(pi) {
  const speech = await import(resolveSpeechEntry(getAgentDir()));
  let huhCommand;
  const safePi = {
    ...pi,
    registerCommand(name, options) {
      if (name === "huh") huhCommand = options;
      return pi.registerCommand(name, options);
    },
    registerShortcut(shortcut, options) {
      return pi.registerShortcut?.(shortcut, options);
    }
  };
  makeHuhExtension(speech)(safePi);
  if (huhCommand) {
    pi.registerShortcut("alt+h", {
      description: huhCommand.description,
      handler: async ctx => huhCommand.handler("", ctx)
    });
  }
}
