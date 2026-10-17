# Enriched Sessions

This document covers techniques for enriching session data with provenance, metadata, and analysis. It focuses on augmenting events (particularly tool calls) with security-relevant information that gets serialized into the session file.

## Overview

The session file (`session.jsonl`) is a JSONL file where each line is an entry. Entries are the atomic units of persistence. By enriching events at runtime, you can embed additional metadata into these entries without creating separate custom entries for every piece of auxiliary information.

**Key insight**: Rather than creating separate `CustomEntry` records for tool enrichment data, you can modify tool result `details` to embed that information directly into the `ToolResultMessage` entry. This co-locates enrichment data with the operation it describes.

See also:
- [Session File Format](https://pi.dev/docs/session) - Session entry types and structure
- [Extensions](https://pi.dev/docs/extensions) - Extension API and event system

---

## Enriching Tool Results

The `tool_result` event fires after a tool executes but before the result is serialized to the session. This is your primary hook for enrichment.

```typescript
import type { ExtensionAPI, ToolResultEvent } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    // Mutate event in place
    event.details = {
      ...event.details,
      enriched: true,
      timestamp: Date.now(),
    };

    // Or return a partial patch
    return {
      details: {
        ...event.details,
        enriched: true,
      }
    };
  });
}
```

Both approaches work. Mutating `event.details` in place modifies the event directly. Returning a partial patch merges with existing values.

### What Can Be Enriched

| Field | Mutable | Notes |
|-------|---------|-------|
| `event.content` | ✅ Yes | Tool output content |
| `event.details` | ✅ Yes | Metadata object (recommended for enrichment) |
| `event.isError` | ✅ Yes | Can toggle error state |

### Practical Example: Provenance Tracking

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isBashToolResult } from "@mariozechner/pi-coding-agent";

interface ProvenanceDetails {
  provenance?: {
    cwd: string;
    user: string;
    host: string;
    toolVersion?: string;
  };
  operation?: {
    type: "read" | "write" | "read-write" | "execute" | "unknown";
    targets: string[];
    dangerous: boolean;
    riskLevel: "none" | "low" | "medium" | "high" | "critical";
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    // Build provenance metadata
    const provenance: ProvenanceDetails["provenance"] = {
      cwd: ctx.cwd,
      user: process.env.USER || "unknown",
      host: require("os").hostname(),
    };

    // Analyze operation type and targets
    const analysis = analyzeToolOperation(event);

    const enrichment: ProvenanceDetails = {
      provenance,
      operation: analysis,
    };

    return {
      details: {
        ...event.details,
        ...enrichment,
      }
    };
  });
}

function analyzeToolOperation(event: ToolResultEvent) {
  if (isBashToolResult(event)) {
    const cmd = event.input.command;
    return {
      type: classifyBashOperation(cmd),
      targets: extractTargets(cmd),
      dangerous: isDangerous(cmd),
      riskLevel: assessRisk(cmd),
    };
  }

  // Default for other tools
  return {
    type: "unknown" as const,
    targets: [],
    dangerous: false,
    riskLevel: "none" as const,
  };
}
```

---

## Classifying Operations: Read, Write, Execute

Understanding what an operation does is critical for security auditing. The `bash` tool is particularly challenging because a single command can read files, write files, create processes, and network—all in one invocation.

### Classification Heuristics

```typescript
type OperationType = "read" | "write" | "read-write" | "execute" | "network" | "unknown";

const READ_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "grep", "find", "ls", "stat",
  "file", "diff", "sort", "uniq", "wc", "cut", "awk", "sed", "rg",
]);

const WRITE_COMMANDS = new Set([
  "cp", "mv", "rm", "mkdir", "rmdir", "touch", "chmod", "chown",
  "echo", "tee", "dd", "install", "rsync",
]);

const EXECUTE_COMMANDS = new Set([
  "bash", "sh", "zsh", "python", "node", "ruby", "perl", "php",
  "make", "cmake", "cargo", "go", "javac", "java",
]);

const NETWORK_COMMANDS = new Set([
  "curl", "wget", "ssh", "scp", "rsync", "nc", "netcat",
  "ping", "traceroute", "dig", "nslookup",
]);

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,
  />\s*\/dev\/sda/,
  /dd\s+if=.*of=\/dev\//,
  /mkfs\./,
  /:()\s*\{\s*:\|:\s*&\s*\}\s*;:/,  // Fork bomb
];

function classifyBashOperation(command: string): OperationType {
  const words = command.trim().split(/\s+/);
  const primary = words[0];

  if (READ_COMMANDS.has(primary)) return "read";
  if (WRITE_COMMANDS.has(primary)) return "write";
  if (EXECUTE_COMMANDS.has(primary)) return "execute";
  if (NETWORK_COMMANDS.has(primary)) return "network";

  // Check for redirects (indicates write)
  if (/[>|=]\s*[^\d]/.test(command)) return "write";

  return "unknown";
}

function extractTargets(command: string): string[] {
  // Extract file paths from common patterns
  const paths: string[] = [];
  
  // Quoted paths
  const quoted = command.match(/'([^']+)'|"([^"]+)"/g);
  if (quoted) paths.push(...quoted.map(p => p.slice(1, -1)));

  // Common flag patterns: -f path, --file=path
  const flagPaths = command.match(/(?:--?[\w-]+(?:=|\s+)(\S+))/g);
  if (flagPaths) paths.push(...flagPaths);

  // Simple path detection
  const simplePaths = command.match(/\/(?:[\w.-]+\/)*[\w.-]+/g);
  if (simplePaths) paths.push(...simplePaths);

  return [...new Set(paths)]; // Deduplicate
}

function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some(p => p.test(command));
}

function assessRisk(command: string): "none" | "low" | "medium" | "high" | "critical" {
  if (DANGEROUS_PATTERNS.some(p => p.test(command))) return "critical";
  if (/sudo\s+/.test(command)) return "high";
  if (/curl|wget.*\|.*sh/.test(command)) return "high"; // Pipe to shell
  if (WRITE_COMMANDS.has(command.split(/\s+/)[0])) return "medium";
  return "low";
}
```

---

## Extension Load Order

Extensions are loaded in this order:

1. **Global extensions**: `~/.pi/agent/extensions/*.ts` and `~/.pi/agent/extensions/*/index.ts`
2. **Project extensions**: `.pi/extensions/*.ts` and `.pi/extensions/*/index.ts`
3. **Settings-defined extensions**: Paths from `settings.json` `extensions` array

Within each category, extensions load alphabetically by filename.

### Controlling Load Order

Since extensions load alphabetically within each category, you can control order with naming:

```
~/.pi/agent/extensions/
├── 01-core-enrichment.ts      ← loads first
├── 02-provenance-tracking.ts   ← loads second
├── 03-security-gate.ts         ← loads third
└── z-sentinel.ts               ← loads last
```

### Handler Chaining

When multiple extensions handle the same event, handlers run in load order. For `tool_result`, each handler sees the patched result from previous handlers:

```typescript
// Extension 01-core-enrichment.ts
pi.on("tool_result", async (event, ctx) => {
  console.log("Handler 1 sees:", event.details);
  return { details: { ...event.details, fromHandler1: true } };
});

// Extension 02-provenance-tracking.ts
pi.on("tool_result", async (event, ctx) => {
  // Sees { fromHandler1: true } from previous handler
  console.log("Handler 2 sees:", event.details);
  return { details: { ...event.details, fromHandler2: true } };
});

// Result: { fromHandler1: true, fromHandler2: true }
```

This is useful for building enrichment pipelines where each extension contributes a layer of metadata.

---

## Offline Analysis with Fast Models

Sometimes you want to analyze what a tool is doing without logging that analysis to the session. You can spawn an offline agent for this purpose.

### Use Cases

- Classify operation risk using a fast model (e.g., Haiku)
- Analyze bash command intent without polluting session history
- Extract structured data from unstructured output
- Pre-flight checks before allowing dangerous operations

### Implementation Pattern

```typescript
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

interface AnalysisResult {
  intent: string;
  riskLevel: "safe" | "caution" | "dangerous";
  readOperations: string[];
  writeOperations: string[];
  networkActivity: string[];
  summary: string;
}

// Use a fast model for analysis
const ANALYSIS_MODEL = "claude-haiku-4-5";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = (event.input as { command: string }).command;
    
    // Quick heuristics first (skip model for obvious cases)
    if (isTriviallySafe(command)) return;
    if (isTriviallyDangerous(command)) {
      const ok = await ctx.ui.confirm("Dangerous Command", `Allow: ${command}`);
      if (!ok) return { block: true, reason: "Blocked by security extension" };
      return;
    }

    // Use fast model for ambiguous cases
    const analysis = await analyzeWithModel(command, ctx.signal);
    
    if (analysis.riskLevel === "dangerous") {
      const ok = await ctx.ui.confirm(
        "Risky Command Detected",
        `Intent: ${analysis.intent}\nRisk: ${analysis.riskLevel}\n\nAllow: ${command}`
      );
      if (!ok) return { block: true, reason: "Blocked by security extension" };
    }

    // Store analysis in event for later enrichment
    (event as any).__analysis = analysis;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const analysis = (event as any).__analysis;
    if (!analysis) return;

    return {
      details: {
        ...event.details,
        offlineAnalysis: {
          intent: analysis.intent,
          riskLevel: analysis.riskLevel,
          operations: {
            read: analysis.readOperations,
            write: analysis.writeOperations,
            network: analysis.networkActivity,
          },
          model: ANALYSIS_MODEL,
          analyzedAt: new Date().toISOString(),
        }
      }
    };
  });
}

async function analyzeWithModel(command: string, signal?: AbortSignal): Promise<AnalysisResult> {
  const messages: Message[] = [{
    role: "user",
    content: [{
      type: "text",
      text: `Analyze this bash command and respond with JSON:

Command: ${command}

Respond with:
{
  "intent": "what the command does in one sentence",
  "riskLevel": "safe|caution|dangerous",
  "readOperations": ["files/directories read"],
  "writeOperations": ["files/directories written/modified"],
  "networkActivity": ["network operations"],
  "summary": "brief explanation"
}

Only include items in arrays if they are clearly present.`,
    }],
    timestamp: Date.now(),
  }];

  try {
    const model = await findModel(ANALYSIS_MODEL);
    const auth = await getApiKey(model.provider);
    
    const response = await complete(
      model,
      { messages },
      { apiKey: auth.apiKey, signal }
    );

    const text = response.content.find((c): c is { type: "text"; text: string } => c.type === "text")?.text;
    
    if (text) {
      const parsed = JSON.parse(text);
      return {
        intent: parsed.intent || "unknown",
        riskLevel: parsed.riskLevel || "safe",
        readOperations: parsed.readOperations || [],
        writeOperations: parsed.writeOperations || [],
        networkActivity: parsed.networkActivity || [],
        summary: parsed.summary || "",
      };
    }
  } catch (error) {
    console.error("Analysis failed:", error);
  }

  return {
    intent: "analysis unavailable",
    riskLevel: "caution",
    readOperations: [],
    writeOperations: [],
    networkActivity: [],
    summary: "Analysis model unavailable",
  };
}
```

### Key Design Decisions

1. **Don't log the analysis prompts**: By using `complete()` directly, the analysis conversation never touches the session. Only the structured result is embedded.

2. **Use the fastest model available**: Haiku is designed for speed. The analysis should complete in under a second.

3. **Fail safely**: If the analysis model is unavailable, default to caution rather than blocking or allowing by default.

4. **Store intermediate results in event**: The `__analysis` property passes data between `tool_call` and `tool_result` handlers without needing module-level state.

### Alternative: Subagent Pattern

For more complex analysis, you can spawn a full subagent (see `examples/extensions/subagent/`). This runs a separate `pi` process with its own context:

```typescript
// Spawn analysis subagent (runs in separate process, separate session)
const analysisResult = await runSubagent({
  agent: "analyzer",  // Defined in ~/.pi/agent/agents/
  task: `Analyze this command: ${command}`,
}, signal);
```

The subagent approach:
- Runs in a completely isolated `pi` process
- Has its own session file (if any)
- Can use different tools and model than main agent
- More heavyweight than direct `complete()` calls

---

## Security Considerations

### Provenance is Trustworthy Within the Session

When enrichment data is embedded in `details`, it carries the same trust level as the tool result itself. If a tool returns "file modified successfully," the enrichment saying "target: /etc/passwd" is equally trustworthy.

### Caveats

1. **Extension compromise**: A malicious extension could modify enrichment data. If security depends on enrichment, load only trusted extensions.

2. **Model hallucinations**: If using AI for analysis (offline or otherwise), the analysis could be wrong. Use heuristics as ground truth where possible.

3. **Timing attacks**: Enrichment happens post-execution for `tool_result`. The operation already occurred.

4. **Co-mingling with output**: Enrichment in `details` is serialized alongside tool output. Don't store secrets there.

### Audit Patterns

For security-critical auditing, consider:

```typescript
// Sign enrichment data (if needed)
import { createHmac } from "crypto";

function signEnrichment(data: object, secret: string): object & { _signature: string } {
  const hmac = createHmac("sha256", secret);
  hmac.update(JSON.stringify(data));
  return {
    ...data,
    _signature: hmac.digest("hex"),
  };
}

// Verify on session replay
function verifyEnrichment(data: object & { _signature?: string }, secret: string): boolean {
  if (!data._signature) return false;
  const { _signature, ...payload } = data;
  const expected = createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
  return _signature === expected;
}
```

---

## Complete Example: Provenance Extension

```typescript
import type { ExtensionAPI, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import type { Message } from "@mariozechner/pi-ai";
import { isBashToolResult } from "@mariozechner/pi-coding-agent";
import os from "os";

interface ProvenanceEnrichment {
  provenance: {
    timestamp: string;
    host: string;
    user: string;
    cwd: string;
  };
  operation: {
    type: "read" | "write" | "read-write" | "execute" | "network" | "unknown";
    classificationMethod: "heuristic" | "model";
    targets: string[];
    riskLevel: "none" | "low" | "medium" | "high" | "critical";
    intent?: string;        // From model analysis
    summary?: string;        // From model analysis
  };
}

const SAFE_COMMANDS = new Set(["ls", "pwd", "whoami", "echo", "true", "false"]);
const DANGEROUS_PATTERNS = [
  /rm\s+-rf/,
  />\s*\/dev\//,
  /dd\s+.*of=\/dev\//,
  /\|\s*sh$/,
];

export default function (pi: ExtensionAPI) {
  // Cache analysis results to avoid repeated model calls
  const analysisCache = new Map<string, ProvenanceEnrichment["operation"]>();

  pi.on("tool_result", async (event, ctx) => {
    const enrichment = buildEnrichment(event, ctx);
    
    return {
      details: {
        ...event.details,
        provenance: enrichment,
      }
    };
  });
}

function buildEnrichment(event: ToolResultEvent, ctx: ExtensionContext): ProvenanceEnrichment {
  return {
    provenance: {
      timestamp: new Date().toISOString(),
      host: os.hostname(),
      user: process.env.USER || "unknown",
      cwd: ctx.cwd,
    },
    operation: analyzeOperation(event),
  };
}

function analyzeOperation(event: ToolResultEvent): ProvenanceEnrichment["operation"] {
  if (isBashToolResult(event)) {
    return analyzeBash(event.input.command);
  }
  
  // Default for non-bash tools
  return {
    type: "unknown",
    classificationMethod: "heuristic",
    targets: [],
    riskLevel: "none",
  };
}

function analyzeBash(command: string): ProvenanceEnrichment["operation"] {
  // Fast path: obvious cases
  const primary = command.trim().split(/\s+/)[0];
  
  if (SAFE_COMMANDS.has(primary)) {
    return {
      type: classifyCommand(primary),
      classificationMethod: "heuristic",
      targets: [],
      riskLevel: "none",
    };
  }

  if (DANGEROUS_PATTERNS.some(p => p.test(command))) {
    return {
      type: "execute",
      classificationMethod: "heuristic",
      targets: extractPaths(command),
      riskLevel: "critical",
    };
  }

  return {
    type: classifyCommand(primary),
    classificationMethod: "heuristic",
    targets: extractPaths(command),
    riskLevel: assessRisk(command),
  };
}

function classifyCommand(cmd: string): ProvenanceEnrichment["operation"]["type"] {
  const read = ["cat", "head", "tail", "less", "grep", "find", "ls", "stat", "diff"];
  const write = ["cp", "mv", "rm", "mkdir", "touch", "chmod", "chown", "tee", "dd"];
  const exec = ["bash", "sh", "python", "node", "ruby", "perl", "make", "cargo"];
  const net = ["curl", "wget", "ssh", "scp", "nc"];

  if (read.includes(cmd)) return "read";
  if (write.includes(cmd)) return "write";
  if (exec.includes(cmd)) return "execute";
  if (net.includes(cmd)) return "network";
  return "unknown";
}

function extractPaths(command: string): string[] {
  const paths: string[] = [];
  
  // Quoted strings
  const quoted = command.match(/'([^']+)'|"([^"]+)"/g);
  if (quoted) paths.push(...quoted.map(p => p.slice(1, -1)));

  // Path-like strings
  const pathRegex = /\/(?:[\w.-]+\/)*[\w.-]+/g;
  const matches = command.match(pathRegex);
  if (matches) paths.push(...matches);

  return [...new Set(paths)];
}

function assessRisk(command: string): ProvenanceEnrichment["operation"]["riskLevel"] {
  if (/sudo\s+/.test(command)) return "high";
  if (/curl|wget.*\|.*sh/.test(command)) return "high";
  if (WRITE_COMMANDS.has(command.split(/\s+/)[0])) return "medium";
  return "low";
}

const WRITE_COMMANDS = new Set(["cp", "mv", "rm", "mkdir", "chmod", "chown", "tee", "dd", "touch"]);
```

---

## Further Reading

- [Session File Format](https://pi.dev/docs/session) - Session entry types
- [Extensions](https://pi.dev/docs/extensions) - Full extension API
- [SDK](https://pi.dev/docs/sdk) - Programmatic session control
- [Subagent Example](../examples/extensions/subagent/) - Offline agent pattern
