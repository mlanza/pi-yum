#!/usr/bin/env node

/**
 * whatsop/cli.js – CLI harness for replaying JSONL session logs through core.js.
 *
 * Outputs pure JSONL by default (one result per line) for piping into jq, etc.
 *
 * Usage:
 *   node whatsop/cli.js <session-id>.jsonl [options]
 *
 * Options:
 *   --limit <N>        Only process N invocations (after skip)
 *   --skip <N>         Skip first N invocations
 *   -pp, --pretty-print  Pretty-print output (human-readable)
 *   --cwd <path>       Override the working directory
 *   --summary-only     Only print summary count to stderr, no JSON output
 *   --data-only        Print only `data`-typed args' expanded nodes
 *   --help, -h         Show help
 */

import { Command } from "@cliffy/command";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalize } from "./core.js";

// ─── CLI definition ─────────────────────────────────────────────────────────

const cmd = new Command()
  .name("whatsop")
  .description("Replay JSONL session logs through the normalization pipeline.")
  .version("0.1.0")
  .arguments("[file:string]")
  .option("--cwd <path:string>", "Working directory (default: current dir)")
  .option("--limit <n:number>", "Only process N invocations (after skip)")
  .option("--skip <n:number>", "Skip first N invocations")
  .option("--pretty-print", "Pretty-print output (human-readable)")
  .option("--summary-only", "Only print summary count to stderr")
  .option("--data-only", "Print only data-typed args' expanded nodes")
  .help({ options: { sort: false } });

const { options, args: positional } = await cmd.parse(process.argv.slice(2));

const file = positional[0];
const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
const skip = options.skip || 0;
const limit = options.limit || Infinity;
const prettyPrint = !!options.prettyPrint;
const summaryOnly = !!options.summaryOnly;
const dataOnly = !!options.dataOnly;

if (!file) {
  console.error("Error: missing JSONL file path");
  cmd.showHelp();
  process.exit(1);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  let content;
  try {
    content = readFileSync(file, "utf-8");
  } catch (err) {
    console.error(`Error reading ${file}: ${err.message}`);
    process.exit(1);
  }

  const lines = content.trim().split("\n").filter(Boolean);
  const slice = lines.slice(skip, skip + limit);
  let total = 0;
  let errors = 0;

  for (const line of slice) {
    let invocation;
    try { invocation = JSON.parse(line); } catch {
      console.error(`[SKIP] Invalid JSON line: ${line.slice(0, 80)}...`);
      errors++;
      continue;
    }

    try {
      const result = await normalize(invocation, { cwd });

      if (summaryOnly) { total++; continue; }

      if (dataOnly) {
        for (const sc of result.subcommands) {
          for (const arg of sc.args) {
            if (arg.type === "data" && arg.expanded && arg.expanded.length > 0) {
              const out = { origin: result.origin, actor: sc.actor, data: arg.data, expanded: arg.expanded };
              console.log(prettyPrint ? JSON.stringify(out, null, 2) : JSON.stringify(out));
            }
          }
        }
        total++;
        continue;
      }

      console.log(prettyPrint ? JSON.stringify(result, null, 2) : JSON.stringify(result));
      if (prettyPrint) console.log("");
      total++;
    } catch (err) {
      console.error(`[ERROR] Processing line: ${err.message}`);
      errors++;
    }
  }

  // Summary goes to stderr only — never pollutes stdout
  if (summaryOnly || errors > 0) {
    const totalLines = lines.length;
    const skippedActual = Math.min(skip, totalLines);
    const available = totalLines - skippedActual;
    const processed = Math.min(limit, available);
    process.stderr.write(
      `Processed ${processed} of ${available} available invocation(s)` +
      `${skippedActual > 0 ? ` (skipped ${skippedActual})` : ""}` +
      `${errors ? ` (${errors} error(s))` : ""}\n`
    );
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
