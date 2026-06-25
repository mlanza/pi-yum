# PRD: leap.js Extension ("leap")

## 1. Overview
This document defines the product requirements for a new pi coding-agent extension, **leap.js** (named **jump.js** in the current implementation), which introduces two complementary mechanisms for restarting a conversation session with context carried forward:

1. A slash command `/leap [optional addendum]` invoked by the human.
2. A programmatic tool call `leap(addendum?)` invoked by the agent.

Both triggers launch a _new internal session_ seeded with the last agent response from the prior session, plus any optional addendum text. If an addendum is provided, the agent automatically takes its next turn; otherwise, it awaits further user input.

## 2. Goals and Motivation
- **Continuity**: Preserve conversational context when branching or restarting sessions.
- **Symmetry**: Enable both human and agent to initiate the same context-leap action **without requiring the other party to participate**. The agent can autonomously restart a session via the tool, making the human superfluous for that operation.
- **Autonomy**: The tool path must work without requiring the human to review, approve, or orchestrate the handoff. When the agent calls `leap()`, the new session is created and the agent auto-triggers immediately.
- **Flexibility**: Support optional addendum text that can guide the agent's next turn.

## 3. User Stories

| ID  | Role            | Feature                                                | Benefit                                                 |
| --- | --------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| US1 | User            | `/leap`                                                | Restart the session with the previous agent response    |
| US2 | User            | `/leap <addendum>`                                     | Restart the session and append guidance for the agent   |
| US3 | Agent           | `leap()`                                               | Programmatically trigger the same restart behavior      |
| US4 | Agent           | `leap("<addendum>")`                                 | Programmatically restart with addendum to drive action  |

## 4. Functional Requirements

1. **Slash Command Registration**  
   - Register a new command `/leap [text]` in the extension manifest.  
   - The command accepts zero or more characters of freeform text.

2. **Tool Registration**  
   - Expose a tool named `leap` (e.g., via `registerTool`), accepting an optional string parameter `addendum`.

3. **Context Capture & Session Restart**  
   - On invocation (either `/leap` or `leap`), retrieve the **last agent response** from the preceding session.
   - Build the initial message payload for the new session:
     1. System / assistant role message containing the last response.
     2. If `addendum` is non-empty, append it as a user-role message.
   - Start a brand-new session context with these messages.

4. **Auto-Response Logic**
   - If an `addendum` was provided, immediately dispatch the agent's next turn by sending the continuation prompt as a user message (`sendUserMessage`).
   - If no `addendum` was provided, place the last assistant content in the editor (`setEditorText`) and wait for the user's input. Do NOT auto-trigger the agent.

5. **Edge Cases & Error Handling**  
   - If there is no prior agent response (e.g., first interaction), respond with an error or guidance message.
   - Sanitize and limit the length of `addendum` to prevent runaway prompts.

## 5. Non-Functional Requirements

- **Performance**: Restarting the session must incur minimal overhead.
- **Reliability**: Robust handling when history is missing or corrupted.
- **Security**: No arbitrary code execution via addendum text.
- **Extensibility**: Clear separation of command vs. tool logic for future enhancements.

## 6. API & Usage Examples

### 6.1 Slash Command `/leap`
```text
/leap                  → restarts with last response, waits for user input
/leap Please summarize → restarts and prompts agent to summarize
```

### 6.2 Tool Call `leap`
```js
await tools.leap();                   // same as `/leap`
await tools.leap("Outline next steps.");
```

## 7. Acceptance Criteria

1. **Command works**: `/leap` launches a fresh session seeded with the last agent message.
2. **Autonomous tool**: `leap()` works without human review or approval. The agent calls it, and the new session is created with the agent auto-triggered.
3. **Verification**: After a successful `/leap` or `leap()`, the agent sees only the continuation prompt (last assistant content ± addendum), not the full prior conversation history. If the agent still sees all previous messages, the session was **not** properly replaced.
4. **Human superfluous for tool path**: When the agent initiates the jump, no human should need to submit, confirm, or orchestrate. The agent handles the entire handoff.
5. **Addendum triggers auto-response**: When addendum is provided, the agent auto-triggers immediately in the new session. Without addendum, the editor is populated with the last context but the agent does NOT auto-trigger — it waits for user input.
6. **Tool parity**: `leap()` behaves identically to `/leap` internally, differing only in invocation path. The same auto-response logic applies with or without addendum.
7. **Error flows**: Proper user feedback when history is unavailable.
8. **Tests**: Unit and integration tests cover happy and error paths.

## 8. Implementation Considerations

- Use pi extension SDK: `registerCommand`, `registerTool`, and `newSession` APIs.
- Store or retrieve last agent response from session context/history service.
- **Do not seed via `setup()`**: Seeding an assistant message via `setup()` requires a full `Usage` object (input, output, cacheRead, cacheWrite, totalTokens, cost) to avoid a footer render crash. Instead, extract the last assistant content as text and send it via `sendUserMessage()` inside `withSession()`. This avoids the footer crash entirely and auto-triggers the agent.
- Call `waitForIdle()` before `newSession()` to ensure the agent has finished streaming.
- The tool queues `/leap` as a `followUp` user message (cannot call `newSession()` directly from a tool context). The command handler performs the actual session replacement.
- Limit addendum to a configurable maximum length (e.g., 500 characters).
- Write automated tests under `tests/` to simulate the slash command and tool invocation.

---

*Document version: 1.0.0*  
*Authored: 2026-06-25*  

*End of PRD.*