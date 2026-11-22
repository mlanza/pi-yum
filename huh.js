import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { makeHuhExtension, resolveSpeechEntry } from "./huh/core.js";

export default async function huh(pi) {
  const speech = await import(resolveSpeechEntry(getAgentDir()));
  makeHuhExtension(speech)(pi);
}
