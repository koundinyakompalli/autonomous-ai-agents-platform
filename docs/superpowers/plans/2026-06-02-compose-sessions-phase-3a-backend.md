# Compose Sessions — Phase 3a: Clarification backend (context pass + chat agent + readiness + SSE) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Compose sessions the "Claude-against-a-folder" clarification loop on the backend: an **Analyze Sources** pass that reads the converted sources and produces session context + open questions, a **resumable chat agent** the operator converses with, a **readiness verdict** that gates handoff, and an **SSE** channel that streams assistant turns live.

**Architecture:** A persistent Claude SDK agent (`runAgent` with `resumeSessionId`/`forkSessionOnResume`) runs read-only against the session's EFS workspace (the converted `sources/*.md` the conversion worker already writes, plus a generated `context.md` and an accumulating `chat.md`). It returns a structured envelope `{ reply, readiness, contextMarkdown? }`. The `claude_session_id` is persisted so each turn resumes the warm thread. Turns are persisted to `compose_session_messages` AND mirrored into `chat.md`. An SSE endpoint streams `status`/`message`/`readiness` events with a sub-60s heartbeat (the spec-factory ALB target group has no `idle_timeout`, so it defaults to 60s — connections must emit bytes more often than that).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node 20, Express, MySQL (`mysql2/promise`), Vitest, Zod, the in-repo `claude-sdk` (`runAgent`, `registerRepoFromPath`). Backend lives in `src/spec-factory/`.

**Scope of this phase (3a — backend only):** the chat/context/readiness agent, its workspace materialization, the persistence (messages + claude_session_id + readiness), the routes (`/analyze`, `/messages`, `/stream`), and an SSE hub. **NOT in this phase:** the dashboard React UI (Phase 3b — the modal, three-panel workspace, source badges, chat box, preview pane, the Analyze/Generate-Draft buttons and confetti), and audio/voxtral (Phase 4). The `/handoff` route already exists (Phase 1); this phase only adds an optional readiness check in front of it.

**Conventions (verified in the codebase):**
- ESM imports use `.js` suffixes. Colocated `*.test.ts`, Vitest. Run one file: `npx vitest run src/spec-factory/<file>.test.ts`. Typecheck: `npm run build`.
- The chat agent mirrors `SpecFactoryQualifier` (`src/spec-factory/qualifier.ts`): `runAgent({ taskId, taskPrompt, repoIds: [workspaceRepoId], agentType: "custom", sdkStage, permissionLevel: "read_only", allowWrite: false, timeoutMs, outputSchema, bedrockConfig: { region, model }, systemAppend })` returns `{ success, structuredOutput, output, sessionId, error, metrics }`. For multi-turn, also pass `resumeSessionId` + `forkSessionOnResume: false` (continue in place).
- Workspace registration: `registerRepoFromPath(absPath)` → repoId (from `src/claude-sdk/index.js`), same as `evidence-workspace.ts` uses.
- The conversion worker (Phase 2) writes converted markdown to `<workspacePath>/sources/<id>-<name>.md` and to the `markdown_content` DB column; `ComposeRepository.listSessionSourceContents(sessionId)` returns `{filename, content}[]` for converted sources.
- `ComposeRepository` already has: `getSession`, `appendMessage({sessionId, role, content})`, `listSessionSourceContents`. The session row already has `claude_session_id`, `readiness_json`, `workspace_path` columns (migration 037) and `ComposeSessionSummary` exposes `claudeSessionId`, `readiness`, `workspacePath`.
- `ComposeReadiness` type exists: `{ ready: boolean; openQuestions: string[]; summary: string }`.
- The service constructor signature (main) is `(composeRepository, specRepository, draftRequester, uploads, conversionWorker, config)`.

---

## Key design decisions (read before starting)

1. **The chat agent returns a structured envelope, not free text.** `outputSchema` forces `{ reply: string, readiness: { ready, openQuestions[], summary }, contextMarkdown?: string }`. `reply` is the assistant's chat turn; `readiness` is re-emitted every turn (drives the Generate-Draft button); `contextMarkdown` is only produced by the **Analyze** pass (the first/explicit context build) and is written to `context.md`.
2. **Resumable session.** First turn (Analyze) runs without `resumeSessionId` and persists the returned `sessionId` to `claude_session_id`. Subsequent turns pass `resumeSessionId = claudeSessionId`, `forkSessionOnResume: false` (continue the same thread). This is the "warm thread."
3. **Workspace is the source of truth the agent reads.** Before each agent run we (re)materialize the session workspace: ensure `sources/*.md` exist (they do, from conversion), (re)write `chat.md` from `compose_session_messages`, and register the dir as an SDK repo → `repoId`. The agent reads files; the prompt is metadata + instructions only (mirrors the qualifier's "read the workspace" discipline).
4. **One active turn per session.** An in-memory per-session lock (`Set<number>` of busy session ids) rejects a concurrent message with a clear error. Sessions are independent.
5. **SSE heartbeat < 60s.** The spec-factory ALB target group sets no `idle_timeout` (defaults to 60s). The SSE stream sends a `: ping` comment every 20s so a long agent turn doesn't get the connection reaped. Turns are also persisted, so a dropped SSE never loses data — the client refetches messages on reconnect.
6. **Persistence is the contract; SSE is a live view.** Every user message and assistant turn is written to `compose_session_messages` first. The SSE stream is a convenience for live updates; the message list endpoint is the durable read.

---

## File Structure

**Create:**
- `src/spec-factory/compose-chat-agent.ts` — `ComposeChatAgent`: wraps `runAgent` for the context/clarify turns; returns the structured envelope.
- `src/spec-factory/compose-chat-agent.test.ts`
- `src/spec-factory/compose-workspace.ts` — `ComposeWorkspaceManager`: materialize `context.md`/`chat.md` into the session workspace + register the SDK repo.
- `src/spec-factory/compose-workspace.test.ts`
- `src/spec-factory/compose-sse.ts` — `ComposeSseHub`: per-session SSE subscriber registry + publish + heartbeat.
- `src/spec-factory/compose-sse.test.ts`

**Modify:**
- `src/spec-factory/compose-types.ts` — add `ComposeChatEnvelope` + `ComposeChatEventSchema` types.
- `src/spec-factory/compose-database.ts` — add `listMessages`, `setClaudeSessionId`, `setReadiness`.
- `src/spec-factory/compose-database.test.ts`
- `src/spec-factory/compose-service.ts` — add `analyze`, `postMessage`, `listMessages`, `getReadiness`; readiness gate helper for handoff; wire the chat agent + workspace manager + SSE hub.
- `src/spec-factory/compose-service.test.ts`
- `src/spec-factory/compose-routes.ts` — add `POST /sessions/:id/analyze`, `POST /sessions/:id/messages`, `GET /sessions/:id/messages`, `GET /sessions/:id/stream` (SSE).
- `src/spec-factory/compose-routes.test.ts`
- `src/spec-factory/server.ts` — construct `ComposeChatAgent`, `ComposeWorkspaceManager`, `ComposeSseHub`; pass to `ComposeService`.

No DB migration is needed — `claude_session_id` and `readiness_json` already exist (migration 037).

---

## Task 1: Chat envelope + event types

**Files:**
- Modify: `src/spec-factory/compose-types.ts`
- Test: `src/spec-factory/compose-types.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/spec-factory/compose-types.test.ts`:

```ts
import {
  ComposeChatEnvelopeSchema,
  type ComposeChatEvent,
} from "./compose-types.js";

describe("compose chat types", () => {
  it("ComposeChatEnvelopeSchema parses a full envelope and defaults", () => {
    const parsed = ComposeChatEnvelopeSchema.parse({
      reply: "Which repository is this for?",
      readiness: { ready: false, openQuestions: ["Which repo?"], summary: "Need the repo." },
    });
    expect(parsed.reply).toContain("repository");
    expect(parsed.readiness.ready).toBe(false);
    expect(parsed.contextMarkdown).toBeUndefined();
  });

  it("ComposeChatEvent is a discriminated union of stream events", () => {
    const ev: ComposeChatEvent = { type: "message", role: "assistant", content: "hi" };
    expect(ev.type).toBe("message");
    const ready: ComposeChatEvent = { type: "readiness", readiness: { ready: true, openQuestions: [], summary: "ok" } };
    expect(ready.type).toBe("readiness");
    const status: ComposeChatEvent = { type: "status", status: "thinking" };
    expect(status.status).toBe("thinking");
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose-types.test.ts`

- [ ] **Step 3: Implement**

In `src/spec-factory/compose-types.ts`, add (the `z` import and `ComposeReadiness` interface already exist):

```ts
export const ComposeReadinessSchema = z.object({
  ready: z.boolean(),
  openQuestions: z.array(z.string().trim().min(1)).default([]),
  summary: z.string().trim().default(""),
});

export const ComposeChatEnvelopeSchema = z.object({
  reply: z.string().trim().min(1),
  readiness: ComposeReadinessSchema,
  contextMarkdown: z.string().trim().min(1).optional(),
});
export type ComposeChatEnvelope = z.infer<typeof ComposeChatEnvelopeSchema>;

export type ComposeChatEvent =
  | { type: "status"; status: "thinking" | "idle" | "error"; message?: string }
  | { type: "message"; role: ComposeMessageRole; content: string }
  | { type: "readiness"; readiness: ComposeReadiness };
```

> `ComposeReadinessSchema` is the Zod mirror of the existing `ComposeReadiness` interface; keep both (the interface is the read-model type, the schema validates agent output).

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-types.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-types.ts src/spec-factory/compose-types.test.ts
git commit -m "feat(compose): add chat envelope + stream event types"
```

---

## Task 2: Repository — listMessages, setClaudeSessionId, setReadiness

**Files:**
- Modify: `src/spec-factory/compose-database.ts`
- Test: `src/spec-factory/compose-database.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/spec-factory/compose-database.test.ts`:

```ts
it("listMessages returns ordered session messages", async () => {
  const query = vi.fn().mockResolvedValueOnce([
    [
      { id: 1, session_id: 3, role: "assistant", content: "Which repo?", created_at: "2026-06-02T00:00:00.000Z" },
      { id: 2, session_id: 3, role: "user", content: "billing-service", created_at: "2026-06-02T00:01:00.000Z" },
    ],
    [],
  ]);
  const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);
  const msgs = await repo.listMessages(3);
  expect(msgs).toEqual([
    { id: 1, sessionId: 3, role: "assistant", content: "Which repo?", createdAt: "2026-06-02T00:00:00.000Z" },
    { id: 2, sessionId: 3, role: "user", content: "billing-service", createdAt: "2026-06-02T00:01:00.000Z" },
  ]);
  expect(String(query.mock.calls[0][0])).toContain("FROM compose_session_messages");
  expect(String(query.mock.calls[0][0])).toContain("ORDER BY id ASC");
});

it("setClaudeSessionId updates the session", async () => {
  const query = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }, []]);
  const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);
  await repo.setClaudeSessionId({ sessionId: 3, claudeSessionId: "sess-abc" });
  const sql = String(query.mock.calls[0][0]);
  expect(sql).toContain("UPDATE compose_sessions");
  expect(sql).toContain("claude_session_id = ?");
  expect(query.mock.calls[0][1]).toEqual(["sess-abc", 3]);
});

it("setReadiness writes readiness_json and flips status to ready when ready", async () => {
  const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
  const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);
  await repo.setReadiness({ sessionId: 3, readiness: { ready: true, openQuestions: [], summary: "ok" } });
  const sql = String(query.mock.calls[0][0]);
  expect(sql).toContain("UPDATE compose_sessions");
  expect(sql).toContain("readiness_json = CAST(? AS JSON)");
  expect(sql).toContain("status = 'ready'");
});

it("setReadiness leaves status when not ready (only updates json)", async () => {
  const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
  const repo = new ComposeRepository({ query, getConnection: vi.fn() } as never);
  await repo.setReadiness({ sessionId: 3, readiness: { ready: false, openQuestions: ["x"], summary: "no" } });
  const sql = String(query.mock.calls[0][0]);
  expect(sql).toContain("readiness_json = CAST(? AS JSON)");
  expect(sql).not.toContain("status =");
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose-database.test.ts`

- [ ] **Step 3: Implement**

In `src/spec-factory/compose-database.ts`, add these methods to `ComposeRepository`. First ensure a `MessageRow` interface near `SourceRow`:

```ts
interface MessageRow extends mysql.RowDataPacket {
  id: number;
  session_id: number;
  role: ComposeSessionMessageSummary["role"];
  content: string;
  created_at: Date | string;
}
```

```ts
  async listMessages(
    sessionId: number,
  ): Promise<ComposeSessionMessageSummary[]> {
    const [rows] = await this.pool.query<MessageRow[]>(
      `SELECT id, session_id, role, content, created_at
       FROM compose_session_messages
       WHERE session_id = ?
       ORDER BY id ASC`,
      [sessionId],
    );
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      createdAt: toIso(row.created_at),
    }));
  }

  async setClaudeSessionId(input: {
    sessionId: number;
    claudeSessionId: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_sessions SET claude_session_id = ? WHERE id = ?`,
      [input.claudeSessionId, input.sessionId],
    );
  }

  async setReadiness(input: {
    sessionId: number;
    readiness: { ready: boolean; openQuestions: string[]; summary: string };
  }): Promise<void> {
    if (input.readiness.ready) {
      await this.pool.query(
        `UPDATE compose_sessions
         SET readiness_json = CAST(? AS JSON), status = 'ready'
         WHERE id = ?`,
        [JSON.stringify(input.readiness), input.sessionId],
      );
      return;
    }
    await this.pool.query(
      `UPDATE compose_sessions
       SET readiness_json = CAST(? AS JSON)
       WHERE id = ?`,
      [JSON.stringify(input.readiness), input.sessionId],
    );
  }
```

> Note: `setReadiness` only promotes status to `ready`; it never demotes (a session that was `ready` and then gets a follow-up "not ready" verdict keeps its row status — the live readiness is always read from `readiness_json`). This avoids flip-flopping the board status. `handed_off`/`archived` are terminal and not touched here.

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-database.test.ts`

- [ ] **Step 5: Typecheck + commit**

Run: `npm run build` (clean).

```bash
git add src/spec-factory/compose-database.ts src/spec-factory/compose-database.test.ts
git commit -m "feat(compose): repo listMessages + setClaudeSessionId + setReadiness"
```

---

## Task 3: ComposeWorkspaceManager (materialize context.md/chat.md + register SDK repo)

**Files:**
- Create: `src/spec-factory/compose-workspace.ts`
- Test: `src/spec-factory/compose-workspace.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/spec-factory/compose-workspace.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { ComposeWorkspaceManager } from "./compose-workspace.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "compose-ws-"));
}

describe("ComposeWorkspaceManager", () => {
  it("writes chat.md from messages and registers the workspace repo", async () => {
    const ws = await tmpDir();
    const register = vi.fn().mockReturnValue("compose_abc123");
    const mgr = new ComposeWorkspaceManager(register);

    const repoId = await mgr.prepare({
      workspacePath: ws,
      messages: [
        { role: "assistant", content: "Which repo?" },
        { role: "user", content: "billing-service" },
      ],
      contextMarkdown: "# Context\n\nBilling export.",
    });

    expect(repoId).toBe("compose_abc123");
    expect(register).toHaveBeenCalledWith(ws);

    const chat = await fs.readFile(path.join(ws, "chat.md"), "utf8");
    expect(chat).toContain("**assistant**: Which repo?");
    expect(chat).toContain("**user**: billing-service");

    const context = await fs.readFile(path.join(ws, "context.md"), "utf8");
    expect(context).toContain("Billing export.");

    await fs.rm(ws, { recursive: true, force: true });
  });

  it("does not write context.md when contextMarkdown is omitted", async () => {
    const ws = await tmpDir();
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"));
    await mgr.prepare({ workspacePath: ws, messages: [], contextMarkdown: undefined });
    await expect(fs.readFile(path.join(ws, "context.md"), "utf8")).rejects.toThrow();
    await fs.rm(ws, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose-workspace.test.ts`

- [ ] **Step 3: Implement**

Create `src/spec-factory/compose-workspace.ts`:

```ts
import { promises as fs } from "fs";
import path from "path";
import { registerRepoFromPath as defaultRegisterRepoFromPath } from "../claude-sdk/index.js";
import type { ComposeMessageRole } from "./compose-types.js";

type RegisterRepo = (repoPath: string, explicitId?: string) => string;

export interface ComposeWorkspaceMessage {
  role: ComposeMessageRole;
  content: string;
}

function renderChatMarkdown(messages: ComposeWorkspaceMessage[]): string {
  if (messages.length === 0) return "# Conversation\n\n_(no messages yet)_\n";
  const body = messages
    .map((m) => `**${m.role}**: ${m.content}`)
    .join("\n\n");
  return `# Conversation\n\n${body}\n`;
}

export class ComposeWorkspaceManager {
  constructor(
    private readonly registerRepo: RegisterRepo = defaultRegisterRepoFromPath,
  ) {}

  /**
   * Materialize the session workspace for an agent run and register it as an
   * SDK repo. `sources/*.md` are written by the conversion worker; here we
   * (re)write chat.md from the message history and, when provided, context.md.
   * Returns the SDK repoId for runAgent({ repoIds: [repoId] }).
   */
  async prepare(input: {
    workspacePath: string;
    messages: ComposeWorkspaceMessage[];
    contextMarkdown?: string;
  }): Promise<string> {
    await fs.mkdir(input.workspacePath, { recursive: true });
    await fs.mkdir(path.join(input.workspacePath, "sources"), {
      recursive: true,
    });

    await fs.writeFile(
      path.join(input.workspacePath, "chat.md"),
      renderChatMarkdown(input.messages),
      "utf8",
    );

    if (input.contextMarkdown) {
      await fs.writeFile(
        path.join(input.workspacePath, "context.md"),
        input.contextMarkdown,
        "utf8",
      );
    }

    return this.registerRepo(input.workspacePath);
  }
}
```

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-workspace.test.ts`

- [ ] **Step 5: Typecheck + commit**

Run: `npm run build` (clean).

```bash
git add src/spec-factory/compose-workspace.ts src/spec-factory/compose-workspace.test.ts
git commit -m "feat(compose): add ComposeWorkspaceManager (chat.md/context.md + repo register)"
```

---

## Task 4: ComposeChatAgent (the resumable context/clarify agent)

**Files:**
- Create: `src/spec-factory/compose-chat-agent.ts`
- Test: `src/spec-factory/compose-chat-agent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/spec-factory/compose-chat-agent.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ComposeChatAgent } from "./compose-chat-agent.js";

function agentResult(structured: unknown, sessionId = "sess-1") {
  return {
    success: true,
    output: JSON.stringify(structured),
    structuredOutput: structured,
    sessionId,
    metrics: { durationMs: 1, toolCalls: 0, modelUsed: "claude" },
  };
}

describe("ComposeChatAgent", () => {
  it("analyze runs without resume and returns envelope + sessionId", async () => {
    const runAgent = vi.fn().mockResolvedValue(
      agentResult({
        reply: "I read 2 sources. Which repository is this for?",
        readiness: { ready: false, openQuestions: ["Which repo?"], summary: "Need repo." },
        contextMarkdown: "# Context\n\nBilling export.",
      }),
    );
    const agent = new ComposeChatAgent(runAgent as never);

    const out = await agent.run({
      sessionId: 7,
      workspaceRepoId: "compose_abc",
      mode: "analyze",
      resumeSessionId: null,
      latestUserMessage: null,
    });

    expect(out.envelope.readiness.ready).toBe(false);
    expect(out.envelope.contextMarkdown).toContain("Billing export.");
    expect(out.sessionId).toBe("sess-1");
    const call = runAgent.mock.calls[0][0];
    expect(call.repoIds).toEqual(["compose_abc"]);
    expect(call.permissionLevel).toBe("read_only");
    expect(call.resumeSessionId).toBeUndefined();
  });

  it("chat resumes the warm session and passes the user message", async () => {
    const runAgent = vi.fn().mockResolvedValue(
      agentResult(
        { reply: "Got it — billing-service.", readiness: { ready: true, openQuestions: [], summary: "Ready." } },
        "sess-1",
      ),
    );
    const agent = new ComposeChatAgent(runAgent as never);

    const out = await agent.run({
      sessionId: 7,
      workspaceRepoId: "compose_abc",
      mode: "chat",
      resumeSessionId: "sess-1",
      latestUserMessage: "billing-service",
    });

    expect(out.envelope.readiness.ready).toBe(true);
    const call = runAgent.mock.calls[0][0];
    expect(call.resumeSessionId).toBe("sess-1");
    expect(call.forkSessionOnResume).toBe(false);
    expect(call.taskPrompt).toContain("billing-service");
  });

  it("throws when the agent run fails", async () => {
    const runAgent = vi.fn().mockResolvedValue({ success: false, error: "boom", metrics: { durationMs: 1, toolCalls: 0 } });
    const agent = new ComposeChatAgent(runAgent as never);
    await expect(
      agent.run({ sessionId: 7, workspaceRepoId: "r", mode: "analyze", resumeSessionId: null, latestUserMessage: null }),
    ).rejects.toThrow(/boom/);
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose-chat-agent.test.ts`

- [ ] **Step 3: Implement**

Create `src/spec-factory/compose-chat-agent.ts` (mirrors `qualifier.ts` structure):

```ts
import { runAgent as defaultRunAgent } from "../claude-sdk/index.js";
import {
  ComposeChatEnvelopeSchema,
  type ComposeChatEnvelope,
} from "./compose-types.js";

type RunAgent = typeof defaultRunAgent;
type AgentRunResult = Awaited<ReturnType<RunAgent>>;

const COMPOSE_CHAT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string" },
    readiness: {
      type: "object",
      additionalProperties: false,
      properties: {
        ready: { type: "boolean" },
        openQuestions: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
      },
      required: ["ready", "openQuestions", "summary"],
    },
    contextMarkdown: { type: "string" },
  },
  required: ["reply", "readiness"],
};

const ANALYZE_INSTRUCTIONS = [
  "You are the Compose clarification assistant for a software delivery platform.",
  "Your working directory is a session workspace. Read the source material the operator gathered:",
  "- Read sources/*.md (converted documents, notes, transcripts). Read every source file.",
  "- If a source is very large, use grep or Read with offset/limit; do not dump whole files needlessly.",
  "Then DO ALL of the following and return the structured envelope:",
  "1. Produce `contextMarkdown`: a concise, structured brief of the requirement (problem, goals, constraints, any repos/files/systems named in the sources).",
  "2. Write a short `reply` to the operator summarizing what you understood, then ask the most important open questions.",
  "3. Produce `readiness`: ready=false until you have enough to draft an OneShot-ready Epic — specifically you need at least an identifiable repository and enough scope for acceptance criteria. List concrete `openQuestions` that block readiness.",
].join("\n");

const CHAT_INSTRUCTIONS = [
  "You are the Compose clarification assistant. Continue the conversation.",
  "Read sources/*.md and chat.md in your workspace for full context (new sources may have been added since the last turn).",
  "Answer the operator's latest message, integrate any new direction they gave, and ask any remaining open questions.",
  "Re-evaluate `readiness` every turn: ready=true only when you have an identifiable repository and enough scope to draft an OneShot-ready Epic with acceptance criteria.",
  "Only set `contextMarkdown` if the operator's new input materially changes the requirement brief; otherwise omit it.",
].join("\n");

export interface ComposeChatRunInput {
  sessionId: number;
  workspaceRepoId: string;
  mode: "analyze" | "chat";
  resumeSessionId: string | null;
  latestUserMessage: string | null;
}

export interface ComposeChatRunOutput {
  envelope: ComposeChatEnvelope;
  sessionId: string | undefined;
  metrics: AgentRunResult["metrics"];
}

function buildPrompt(input: ComposeChatRunInput): string {
  const header =
    input.mode === "analyze" ? ANALYZE_INSTRUCTIONS : CHAT_INSTRUCTIONS;
  const lines = [
    header,
    "",
    `Compose session id: ${input.sessionId}`,
    "Workspace files: sources/*.md (source material), context.md (your prior brief, if present), chat.md (conversation so far).",
  ];
  if (input.latestUserMessage) {
    lines.push("", "Operator's latest message:", input.latestUserMessage);
  }
  return lines.join("\n");
}

function parseOutput(result: AgentRunResult): unknown {
  if (result.structuredOutput !== undefined) return result.structuredOutput;
  return JSON.parse(result.output);
}

export class ComposeChatAgent {
  constructor(
    private readonly runAgent: RunAgent = defaultRunAgent,
    private readonly modelId: string | undefined =
      process.env.SPEC_FACTORY_MODEL_ID ||
      process.env.ANTHROPIC_MODEL ||
      "us.anthropic.claude-opus-4-8",
    private readonly timeoutMs: number = Number(
      process.env.COMPOSE_CHAT_TIMEOUT_MS || 300000,
    ),
  ) {}

  async run(input: ComposeChatRunInput): Promise<ComposeChatRunOutput> {
    const result = await this.runAgent({
      taskId: `compose-chat-${input.sessionId}-${input.mode}-${Date.now()}`,
      taskPrompt: buildPrompt(input),
      repoIds: [input.workspaceRepoId],
      agentType: "custom",
      sdkStage: "compose_clarify",
      permissionLevel: "read_only",
      allowWrite: false,
      timeoutMs: this.timeoutMs,
      outputSchema: COMPOSE_CHAT_JSON_SCHEMA,
      bedrockConfig: {
        region: process.env.AWS_REGION || "us-east-2",
        model: this.modelId,
      },
      systemAppend:
        "Compose clarification is read-only. Read workspace files (sources/*.md, context.md, chat.md). Return the structured envelope with reply + readiness, and contextMarkdown only when building or materially updating the brief.",
      ...(input.resumeSessionId
        ? { resumeSessionId: input.resumeSessionId, forkSessionOnResume: false }
        : {}),
    });

    if (!result.success) {
      throw new Error(result.error || "Compose chat agent failed");
    }

    const envelope = ComposeChatEnvelopeSchema.parse(parseOutput(result));
    return { envelope, sessionId: result.sessionId, metrics: result.metrics };
  }
}
```

> Note: `sdkStage: "compose_clarify"` is a new stage label. If the SDK type for `sdkStage` is a closed string union that rejects it, use the closest existing read-only stage value (check `AgentRunnerOptions["sdkStage"]` in `src/claude-sdk/index.ts`) and report which you used. If `sdkStage` is a plain `string`, `"compose_clarify"` is fine.

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-chat-agent.test.ts`

- [ ] **Step 5: Typecheck + commit**

Run: `npm run build` (clean — resolve the `sdkStage` note above if it errors).

```bash
git add src/spec-factory/compose-chat-agent.ts src/spec-factory/compose-chat-agent.test.ts
git commit -m "feat(compose): add resumable ComposeChatAgent (analyze + chat envelopes)"
```

---

## Task 5: ComposeSseHub (per-session SSE fan-out + heartbeat)

**Files:**
- Create: `src/spec-factory/compose-sse.ts`
- Test: `src/spec-factory/compose-sse.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/spec-factory/compose-sse.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ComposeSseHub, formatSseEvent } from "./compose-sse.js";

function fakeRes() {
  return {
    written: [] as string[],
    headersSent: false,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write(chunk: string) { this.written.push(chunk); return true; },
    end: vi.fn(),
    on: vi.fn(),
  };
}

describe("ComposeSseHub", () => {
  it("formatSseEvent serializes a named JSON event", () => {
    const s = formatSseEvent({ type: "message", role: "assistant", content: "hi" });
    expect(s).toContain("event: message");
    expect(s).toContain('data: {"type":"message"');
    expect(s.endsWith("\n\n")).toBe(true);
  });

  it("publish writes to all subscribers of a session only", () => {
    const hub = new ComposeSseHub();
    const a = fakeRes();
    const b = fakeRes();
    const other = fakeRes();
    hub.subscribe(7, a as never);
    hub.subscribe(7, b as never);
    hub.subscribe(9, other as never);

    hub.publish(7, { type: "status", status: "thinking" });

    expect(a.written.join("")).toContain("event: status");
    expect(b.written.join("")).toContain("event: status");
    expect(other.written.join("")).toBe("");
  });

  it("unsubscribe removes a subscriber", () => {
    const hub = new ComposeSseHub();
    const a = fakeRes();
    hub.subscribe(7, a as never);
    hub.unsubscribe(7, a as never);
    hub.publish(7, { type: "status", status: "idle" });
    expect(a.written.join("")).toBe("");
  });

  it("heartbeat writes a comment ping to subscribers", () => {
    const hub = new ComposeSseHub();
    const a = fakeRes();
    hub.subscribe(7, a as never);
    hub.heartbeat();
    expect(a.written.join("")).toContain(": ping");
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose-sse.test.ts`

- [ ] **Step 3: Implement**

Create `src/spec-factory/compose-sse.ts`:

```ts
import type { Response } from "express";
import type { ComposeChatEvent } from "./compose-types.js";

export function formatSseEvent(event: ComposeChatEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class ComposeSseHub {
  private readonly subscribers = new Map<number, Set<Response>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  subscribe(sessionId: number, res: Response): void {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(res);
  }

  unsubscribe(sessionId: number, res: Response): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) this.subscribers.delete(sessionId);
  }

  publish(sessionId: number, event: ComposeChatEvent): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    const payload = formatSseEvent(event);
    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        // drop broken pipes; the connection close handler unsubscribes
      }
    }
  }

  /** Write a comment ping to every open connection (keeps the ALB from reaping idle SSE). */
  heartbeat(): void {
    for (const set of this.subscribers.values()) {
      for (const res of set) {
        try {
          res.write(": ping\n\n");
        } catch {
          // ignore
        }
      }
    }
  }

  /** Start the heartbeat loop (call once at server boot). Default 20s < ALB 60s idle. */
  startHeartbeat(intervalMs = 20000): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), intervalMs);
    this.heartbeatTimer.unref?.();
  }
}
```

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-sse.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-sse.ts src/spec-factory/compose-sse.test.ts
git commit -m "feat(compose): add ComposeSseHub (per-session fan-out + heartbeat)"
```

---

## Task 6: ComposeService — analyze, postMessage, listMessages, readiness

**Files:**
- Modify: `src/spec-factory/compose-service.ts`
- Test: `src/spec-factory/compose-service.test.ts`

- [ ] **Step 1: Write the failing tests**

In `compose-service.test.ts`, extend `buildService()`:
- Add to the `composeRepository` mock: `appendMessage: vi.fn().mockResolvedValue(1)`, `listMessages: vi.fn().mockResolvedValue([])`, `listSessionSourceContents: vi.fn().mockResolvedValue([{ filename: "n.md", content: "x" }])`, `setClaudeSessionId: vi.fn().mockResolvedValue(undefined)`, `setReadiness: vi.fn().mockResolvedValue(undefined)`. (Some may already be present — don't duplicate.)
- Add new collaborator mocks:
  ```ts
  const chatAgent = { run: vi.fn() };
  const workspaceManager = { prepare: vi.fn().mockResolvedValue("compose_repo") };
  const sseHub = { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() };
  ```
- Update the `new ComposeService(...)` call to the NEW signature (see Step 3): `(composeRepository, specRepository, draftRequester, uploads, conversionWorker, chatAgent, workspaceManager, sseHub, config)`. Return the three new mocks from buildService.

Make the session mock include `workspacePath` + `claudeSessionId` (the `sessionSummary()` helper already returns `workspacePath` and `claudeSessionId: null`).

Tests:

```ts
it("analyze prepares the workspace, runs the agent without resume, persists session id + readiness + assistant message, and publishes", async () => {
  const { service, composeRepository, chatAgent, workspaceManager, sseHub } = buildService();
  composeRepository.getSession.mockResolvedValue(
    sessionSummary({ id: 7, workspacePath: "/w/7", claudeSessionId: null }),
  );
  chatAgent.run.mockResolvedValue({
    envelope: { reply: "Which repo?", readiness: { ready: false, openQuestions: ["repo?"], summary: "need repo" }, contextMarkdown: "# Context" },
    sessionId: "sess-1",
    metrics: {},
  });

  const result = await service.analyze({ sessionId: 7 });

  expect(workspaceManager.prepare).toHaveBeenCalled();
  expect(chatAgent.run.mock.calls[0][0].mode).toBe("analyze");
  expect(chatAgent.run.mock.calls[0][0].resumeSessionId).toBeNull();
  expect(composeRepository.setClaudeSessionId).toHaveBeenCalledWith({ sessionId: 7, claudeSessionId: "sess-1" });
  expect(composeRepository.appendMessage).toHaveBeenCalledWith({ sessionId: 7, role: "assistant", content: "Which repo?" });
  expect(composeRepository.setReadiness).toHaveBeenCalledWith({ sessionId: 7, readiness: { ready: false, openQuestions: ["repo?"], summary: "need repo" } });
  expect(result.readiness.ready).toBe(false);
});

it("postMessage persists the user turn, resumes the warm session, persists the assistant turn + readiness", async () => {
  const { service, composeRepository, chatAgent } = buildService();
  composeRepository.getSession.mockResolvedValue(
    sessionSummary({ id: 7, workspacePath: "/w/7", claudeSessionId: "sess-1" }),
  );
  chatAgent.run.mockResolvedValue({
    envelope: { reply: "Got it.", readiness: { ready: true, openQuestions: [], summary: "ready" } },
    sessionId: "sess-1",
    metrics: {},
  });

  const result = await service.postMessage({ sessionId: 7, content: "billing-service" });

  // user message persisted first, then assistant
  expect(composeRepository.appendMessage.mock.calls[0][0]).toEqual({ sessionId: 7, role: "user", content: "billing-service" });
  expect(composeRepository.appendMessage.mock.calls[1][0]).toEqual({ sessionId: 7, role: "assistant", content: "Got it." });
  expect(chatAgent.run.mock.calls[0][0].resumeSessionId).toBe("sess-1");
  expect(chatAgent.run.mock.calls[0][0].latestUserMessage).toBe("billing-service");
  expect(result.readiness.ready).toBe(true);
});

it("postMessage rejects a blank message", async () => {
  const { service } = buildService();
  await expect(service.postMessage({ sessionId: 7, content: "   " })).rejects.toThrow(/message/i);
});

it("postMessage rejects a concurrent turn on the same session", async () => {
  const { service, chatAgent } = buildService();
  // make the first run hang so the lock is held
  let release: () => void = () => {};
  chatAgent.run.mockReturnValueOnce(new Promise((r) => { release = () => r({ envelope: { reply: "x", readiness: { ready: false, openQuestions: [], summary: "" } }, sessionId: "s", metrics: {} }); }));
  const first = service.postMessage({ sessionId: 7, content: "a" });
  await expect(service.postMessage({ sessionId: 7, content: "b" })).rejects.toThrow(/in progress|still/i);
  release();
  await first;
});

it("listMessages delegates to the repository", async () => {
  const { service, composeRepository } = buildService();
  composeRepository.listMessages.mockResolvedValue([{ id: 1, sessionId: 7, role: "user", content: "hi", createdAt: "t" }]);
  expect(await service.listMessages(7)).toHaveLength(1);
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose-service.test.ts`

- [ ] **Step 3: Implement**

In `src/spec-factory/compose-service.ts`:

(a) Widen `ComposeServiceComposeRepo` Pick to add: `"appendMessage" | "listMessages" | "listSessionSourceContents" | "setClaudeSessionId" | "setReadiness"`.

(b) Add collaborator interfaces (near the existing ones):

```ts
import type { ComposeChatAgent, ComposeChatRunOutput } from "./compose-chat-agent.js";
import type { ComposeWorkspaceManager } from "./compose-workspace.js";
import type { ComposeSseHub } from "./compose-sse.js";
import type { ComposeReadiness } from "./compose-types.js";

interface ChatAgentLike {
  run(input: {
    sessionId: number;
    workspaceRepoId: string;
    mode: "analyze" | "chat";
    resumeSessionId: string | null;
    latestUserMessage: string | null;
  }): Promise<ComposeChatRunOutput>;
}

interface WorkspaceManagerLike {
  prepare(input: {
    workspacePath: string;
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    contextMarkdown?: string;
  }): Promise<string>;
}

interface SseHubLike {
  publish(sessionId: number, event: import("./compose-types.js").ComposeChatEvent): void;
}
```

(c) Add the three collaborators to the constructor, inserted AFTER `conversionWorker` and BEFORE `config` (new order: `composeRepository, specRepository, draftRequester, uploads, conversionWorker, chatAgent, workspaceManager, sseHub, config`). Store as private readonly. Also add a private `private readonly activeTurns = new Set<number>();`.

(d) Add a private helper that runs one agent turn (shared by analyze + postMessage):

```ts
  private async runTurn(input: {
    sessionId: number;
    mode: "analyze" | "chat";
    latestUserMessage: string | null;
  }): Promise<ComposeReadiness> {
    if (this.activeTurns.has(input.sessionId)) {
      throw new Error(
        `A clarification turn is already in progress for session ${input.sessionId}`,
      );
    }
    this.activeTurns.add(input.sessionId);
    try {
      const session = requireSession(
        await this.composeRepository.getSession(input.sessionId),
        input.sessionId,
      );
      this.sseHub.publish(input.sessionId, { type: "status", status: "thinking" });

      const [messages, sources] = await Promise.all([
        this.composeRepository.listMessages(input.sessionId),
        this.composeRepository.listSessionSourceContents(input.sessionId),
      ]);
      void sources; // sources are read by the agent from sources/*.md on disk
      const repoId = await this.workspaceManager.prepare({
        workspacePath: session.workspacePath,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });

      const { envelope, sessionId: claudeSessionId } = await this.chatAgent.run({
        sessionId: input.sessionId,
        workspaceRepoId: repoId,
        mode: input.mode,
        resumeSessionId: session.claudeSessionId,
        latestUserMessage: input.latestUserMessage,
      });

      if (claudeSessionId && claudeSessionId !== session.claudeSessionId) {
        await this.composeRepository.setClaudeSessionId({
          sessionId: input.sessionId,
          claudeSessionId,
        });
      }
      if (envelope.contextMarkdown) {
        // persist the brief into the workspace for subsequent turns
        await this.workspaceManager.prepare({
          workspacePath: session.workspacePath,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          contextMarkdown: envelope.contextMarkdown,
        });
      }
      await this.composeRepository.appendMessage({
        sessionId: input.sessionId,
        role: "assistant",
        content: envelope.reply,
      });
      await this.composeRepository.setReadiness({
        sessionId: input.sessionId,
        readiness: envelope.readiness,
      });

      this.sseHub.publish(input.sessionId, {
        type: "message",
        role: "assistant",
        content: envelope.reply,
      });
      this.sseHub.publish(input.sessionId, {
        type: "readiness",
        readiness: envelope.readiness,
      });
      this.sseHub.publish(input.sessionId, { type: "status", status: "idle" });
      return envelope.readiness;
    } catch (error) {
      this.sseHub.publish(input.sessionId, {
        type: "status",
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.activeTurns.delete(input.sessionId);
    }
  }
```

(e) Add the public methods:

```ts
  async analyze(input: { sessionId: number }): Promise<ComposeReadiness> {
    return this.runTurn({
      sessionId: input.sessionId,
      mode: "analyze",
      latestUserMessage: null,
    });
  }

  async postMessage(input: {
    sessionId: number;
    content: string;
  }): Promise<ComposeReadiness> {
    const content = input.content.trim();
    if (!content) throw new Error("Message content is required");
    if (this.activeTurns.has(input.sessionId)) {
      throw new Error(
        `A clarification turn is already in progress for session ${input.sessionId}`,
      );
    }
    await this.composeRepository.appendMessage({
      sessionId: input.sessionId,
      role: "user",
      content,
    });
    this.sseHub.publish(input.sessionId, {
      type: "message",
      role: "user",
      content,
    });
    return this.runTurn({
      sessionId: input.sessionId,
      mode: "chat",
      latestUserMessage: content,
    });
  }

  async listMessages(sessionId: number) {
    return this.composeRepository.listMessages(sessionId);
  }
```

> Concurrency note: `postMessage` checks the lock BEFORE persisting the user message so a rejected concurrent turn doesn't write an orphan user message; `runTurn` re-checks (defense-in-depth) and owns the lock for the agent run.

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-service.test.ts`

- [ ] **Step 5: Typecheck + commit**

Run: `npm run build` (clean).

```bash
git add src/spec-factory/compose-service.ts src/spec-factory/compose-service.test.ts
git commit -m "feat(compose): service analyze/postMessage/listMessages + readiness + SSE publish"
```

---

## Task 7: Routes — /analyze, /messages (POST+GET), /stream (SSE)

**Files:**
- Modify: `src/spec-factory/compose-routes.ts`
- Test: `src/spec-factory/compose-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend `makeService()` in `compose-routes.test.ts` with: `analyze: vi.fn()`, `postMessage: vi.fn()`, `listMessages: vi.fn()`, and an `sseHub` is NOT part of the service — the router needs the hub too (see Step 3). For the stream test we need the hub; pass a stub hub into `createComposeRouter`. Adjust the existing `start()` helper to also accept a hub, OR (simpler) have `createComposeRouter(service, sseHub)` and update the harness's router construction. Tests:

```ts
it("POST /sessions/:id/analyze returns the readiness (200)", async () => {
  const service = makeService();
  service.analyze.mockResolvedValue({ ready: false, openQuestions: ["repo?"], summary: "need repo" });
  const ctx = await start(service); server = ctx.server;
  const res = await ctx.request("/api/spec-factory/compose/sessions/7/analyze", { method: "POST" });
  expect(res.status).toBe(200);
  expect(res.body.ready).toBe(false);
  expect(service.analyze).toHaveBeenCalledWith({ sessionId: 7 });
});

it("POST /sessions/:id/messages returns the readiness (200)", async () => {
  const service = makeService();
  service.postMessage.mockResolvedValue({ ready: true, openQuestions: [], summary: "ready" });
  const ctx = await start(service); server = ctx.server;
  const res = await ctx.request("/api/spec-factory/compose/sessions/7/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "billing-service" }),
  });
  expect(res.status).toBe(200);
  expect(res.body.ready).toBe(true);
  expect(service.postMessage).toHaveBeenCalledWith({ sessionId: 7, content: "billing-service" });
});

it("GET /sessions/:id/messages lists messages (200)", async () => {
  const service = makeService();
  service.listMessages.mockResolvedValue([{ id: 1, sessionId: 7, role: "user", content: "hi", createdAt: "t" }]);
  const ctx = await start(service); server = ctx.server;
  const res = await ctx.request("/api/spec-factory/compose/sessions/7/messages");
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(1);
});

it("GET /sessions/:id/stream sets SSE headers and subscribes", async () => {
  const service = makeService();
  const ctx = await start(service); server = ctx.server;
  // abort quickly so the request doesn't hang the test
  const controller = new AbortController();
  const p = ctx.request("/api/spec-factory/compose/sessions/7/stream", { signal: controller.signal }).catch(() => null);
  await new Promise((r) => setTimeout(r, 50));
  expect(ctx.sseHub.subscribe).toHaveBeenCalled();
  controller.abort();
  await p;
});
```

> The `start()` helper must expose the `sseHub` stub it built and pass it to `createComposeRouter(service, sseHub)`. Update the helper accordingly (it already returns `{ server, request }`; add `sseHub`). For the stream test, `request` uses `fetch` with an `AbortSignal`.

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose-routes.test.ts`

- [ ] **Step 3: Implement**

In `src/spec-factory/compose-routes.ts`:

(a) Change the signature to accept the hub: `export function createComposeRouter(service: ComposeRouteService, sseHub: SseHubForRoutes): Router`. Add an interface near the top:

```ts
import type { Request, Response } from "express";

interface SseHubForRoutes {
  subscribe(sessionId: number, res: Response): void;
  unsubscribe(sessionId: number, res: Response): void;
}
```

(b) Widen `ComposeRouteService` Pick to add: `"analyze" | "postMessage" | "listMessages"`.

(c) Add routes (reuse existing `positiveInt`/`handleError`):

```ts
  router.post("/sessions/:sessionId/analyze", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      const readiness = await service.analyze({ sessionId });
      res.status(200).json(readiness);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sessions/:sessionId/messages", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      const content = typeof req.body?.content === "string" ? req.body.content : "";
      const readiness = await service.postMessage({ sessionId, content });
      res.status(200).json(readiness);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/sessions/:sessionId/messages", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      res.setHeader("Cache-Control", "no-cache");
      res.json(await service.listMessages(sessionId));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/sessions/:sessionId/stream", (req, res) => {
    let sessionId: number;
    try {
      sessionId = positiveInt(req.params.sessionId, "sessionId");
    } catch (error) {
      handleError(res, error);
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(": connected\n\n");
    sseHub.subscribe(sessionId, res);
    req.on("close", () => {
      sseHub.unsubscribe(sessionId, res);
    });
  });
```

> The `/messages` POST blocks until the agent turn completes and returns the resulting readiness (the SSE stream also carries the assistant turn for any other open viewers). `Cache-Control: no-transform` + `X-Accel-Buffering: no` discourage intermediary buffering of the SSE stream.

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-routes.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-routes.ts src/spec-factory/compose-routes.test.ts
git commit -m "feat(compose): add analyze/messages/stream (SSE) routes"
```

---

## Task 8: Server wiring + readiness-aware handoff note

**Files:**
- Modify: `src/spec-factory/server.ts`

> No new test file — verified by `npm run build` + the full suite. (server.ts is the composition root; it has no unit test today.)

- [ ] **Step 1: Wire the new collaborators**

In `src/spec-factory/server.ts`:

(a) Add imports:

```ts
import { ComposeChatAgent } from "./compose-chat-agent.js";
import { ComposeWorkspaceManager } from "./compose-workspace.js";
import { ComposeSseHub } from "./compose-sse.js";
```

(b) After the existing compose collaborators (`composeUploads`, `markitdownClient`, `composeConversionWorker`) are constructed, add:

```ts
  const composeChatAgent = new ComposeChatAgent();
  const composeWorkspaceManager = new ComposeWorkspaceManager();
  const composeSseHub = new ComposeSseHub();
  composeSseHub.startHeartbeat(
    Number(process.env.COMPOSE_SSE_HEARTBEAT_MS || 20000),
  );
```

(c) Update the `new ComposeService(...)` call to the new 9-arg signature — insert `composeChatAgent, composeWorkspaceManager, composeSseHub` after `composeConversionWorker` and before the config object:

```ts
  const composeService = new ComposeService(
    composeRepository,
    repository,
    service,
    composeUploads,
    composeConversionWorker,
    composeChatAgent,
    composeWorkspaceManager,
    composeSseHub,
    {
      workspaceBase:
        process.env.COMPOSE_WORKSPACE_BASE?.trim() ||
        "/mnt/efs/specter-repo/spec-factory/compose",
      s3Prefix: process.env.COMPOSE_S3_PREFIX?.trim() || "compose",
    },
  );
```

(d) Update the router mount to pass the hub:

```ts
  app.use(
    "/api/spec-factory/compose",
    createComposeRouter(composeService, composeSseHub),
  );
```

- [ ] **Step 2: Typecheck + full compose suite**

Run: `npm run build` (clean).
Run: `npx vitest run src/spec-factory/compose-types.test.ts src/spec-factory/compose-database.test.ts src/spec-factory/compose-workspace.test.ts src/spec-factory/compose-chat-agent.test.ts src/spec-factory/compose-sse.test.ts src/spec-factory/compose-service.test.ts src/spec-factory/compose-routes.test.ts src/spec-factory/compose-evidence-provider.test.ts src/spec-factory/compose-conversion.test.ts src/spec-factory/compose-uploads.test.ts src/spec-factory/compose-markitdown-client.test.ts`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add src/spec-factory/server.ts
git commit -m "feat(compose): wire chat agent + workspace manager + SSE hub into the server"
```

---

## Task 9: Completion verification & notes

**Files:**
- Create: `docs/superpowers/plans/2026-06-02-compose-sessions-phase-3a-COMPLETION.md`

- [ ] **Step 1: Build + full backend suite**

Run: `npm run build` (clean) and the full compose suite from Task 8 Step 2 (all green). Record counts.

- [ ] **Step 2: Write completion notes**

Create the completion doc covering: what shipped (analyze/chat/readiness/SSE), test/build results, the new endpoints, the SSE-through-ALB constraint (heartbeat < 60s; no `idle_timeout` on the spec-factory target group), env vars (`COMPOSE_CHAT_TIMEOUT_MS`, `COMPOSE_SSE_HEARTBEAT_MS`), the manual verification path (below), and the Phase-3a → Phase-3b handoff.

Manual happy-path (requires the service deployed; uses a converted session from Phase 2):

```
1. (Phase 2) create session + add a note/file → it converts to a source.
2. POST /compose/sessions/<id>/analyze
   -> 200 { ready:false, openQuestions:[...], summary }  ; an assistant message is persisted.
3. GET  /compose/sessions/<id>/stream   (EventSource) -> receives status/message/readiness events.
4. POST /compose/sessions/<id>/messages { "content":"It's the billing-service repo" }
   -> 200 { ready:true|false, ... } ; user+assistant turns persisted; SSE carries them.
5. GET  /compose/sessions/<id>/messages -> the full transcript.
6. When ready:true, POST /compose/sessions/<id>/handoff (existing) -> draft_ready card with the gathered context as evidence.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-06-02-compose-sessions-phase-3a-COMPLETION.md
git commit -m "docs(compose): Phase 3a completion notes"
```

---

## Self-Review

**1. Spec coverage (the design's "Triggers & controls" + "Clarification loop" sections — backend portion):**
- "Analyze Sources" trigger (context pass → context.md + open questions, posted to chat) → Tasks 4 (agent analyze mode), 3 (context.md), 6 (`analyze`). ✓
- Persistent resumable chat ("Claude against a folder") → Tasks 3 (workspace), 4 (resume via claude_session_id), 6 (`postMessage`). ✓
- Open questions appear as chat messages → Task 6 (assistant `reply` persisted + SSE `message`; readiness `openQuestions` carried). ✓
- Readiness verdict gates Generate-Draft → Tasks 2 (`setReadiness`), 4/6 (verdict every turn). The UI button + confetti are Phase 3b; the backend exposes readiness via `analyze`/`postMessage` return + the session's `readiness_json`. ✓
- chat.md as a durable source → Task 3 (rendered from `compose_session_messages`). ✓
- SSE streaming transport → Tasks 5 (hub), 7 (`/stream`), 8 (heartbeat). ✓
- One active turn per session → Task 6 (`activeTurns` lock). ✓
- Deferred (correctly absent): the dashboard React UI (Phase 3b), confetti, voxtral. The `/handoff` readiness gate is informational (the service exposes readiness; enforcing "must be ready unless Draft-anyway" is a UI concern in 3b — the backend already allows handoff at any time, matching the "Draft anyway" override).

**2. Placeholder scan:** No "TBD/TODO/handle errors appropriately". Every code step is complete. The `sdkStage: "compose_clarify"` note (Task 4) is explicit guidance to check the real union type and adapt — not a placeholder. The routes-test harness change (Task 7) to thread the hub is described concretely (pass `sseHub` to `createComposeRouter`, expose it from `start()`).

**3. Type consistency:**
- `ComposeChatEnvelope`/`ComposeReadinessSchema`/`ComposeChatEvent` (Task 1) consumed by the agent (Task 4), service (Task 6), and SSE hub (Task 5). ✓
- `ComposeChatAgent.run(input): Promise<ComposeChatRunOutput>` (Task 4) matches `ChatAgentLike` in the service (Task 6). ✓
- `ComposeWorkspaceManager.prepare({workspacePath, messages, contextMarkdown?}): Promise<string>` (Task 3) matches `WorkspaceManagerLike` (Task 6). ✓
- `ComposeSseHub.publish/subscribe/unsubscribe` (Task 5) match `SseHubLike` (service, Task 6) and `SseHubForRoutes` (routes, Task 7). ✓
- Repo methods `listMessages`/`setClaudeSessionId`/`setReadiness` (Task 2) consumed in the service Pick + calls (Task 6) with matching signatures. ✓
- ComposeService constructor arg order `(…, conversionWorker, chatAgent, workspaceManager, sseHub, config)` consistent across Task 6 (definition), Task 6 tests (buildService), and Task 8 (server). ✓

**Phase-3a → Phase-3b handoff:** the backend now exposes `POST /analyze`, `POST /messages`, `GET /messages`, `GET /stream` (SSE), and readiness on the session. Phase 3b (the dashboard React UI) builds the modal, three-panel workspace, live source badges (from `GET /sessions/:id/sources`, Phase 2), the chat box wired to `/messages` + `/stream`, the **Analyze Sources** button → `/analyze`, the readiness-gated **Generate Draft** button + confetti → existing `/handoff`, and "Draft anyway".
