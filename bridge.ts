#!/usr/bin/env node
/**
 * Pixel Agents Bridge for OpenCode
 *
 * Connects to OpenCode's SSE event stream and translates events into
 * Claude Code-compatible JSONL files so the Pixel Agents VS Code extension
 * can visualize OpenCode agents without any modifications.
 *
 * Usage:
 *   npx tsx bridge.ts [--port 4096]
 *
 * The bridge will:
 *   1. Discover the workspace path via GET /path
 *   2. Listen to SSE events via GET /event
 *   3. Write JSONL records to ~/.claude/projects/<sanitized-path>/<session>.jsonl
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 4096;

interface BridgeConfig {
  url: string;
  password?: string;
}

function parseArgs(): BridgeConfig {
  const args = process.argv.slice(2);
  let url = "";
  let port = DEFAULT_PORT;
  let password: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      url = args[i + 1].replace(/\/+$/, ""); // strip trailing slashes
      i++;
    } else if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      if (isNaN(port)) port = DEFAULT_PORT;
      i++;
    } else if (args[i] === "--password" && args[i + 1]) {
      password = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Pixel Agents Bridge for OpenCode

Connects to OpenCode's SSE event stream and translates events into
Claude Code-compatible JSONL files so Pixel Agents works with OpenCode.

Usage:
  npx tsx bridge.ts [options]

Options:
  --port <port>       Port of the OpenCode server (default: 4096)
  --url <url>         Full URL of the OpenCode server (overrides --port)
  --password <pass>   Basic auth password (if server has OPENCODE_SERVER_PASSWORD set)
  --help, -h          Show this help

Prerequisites:
  OpenCode must be running with its HTTP server enabled:
    opencode --port 4096            # TUI + server on port 4096
    opencode serve --port 4096      # Headless server
    opencode web --port 4096        # Web UI + server

  Then in another terminal:
    npx tsx bridge.ts --port 4096

  Open a VS Code terminal and install the Pixel Agents extension.
  The bridge will write JSONL files that Pixel Agents picks up automatically.
`);
      process.exit(0);
    }
  }

  // OPENCODE_SERVER_PASSWORD env var as fallback
  if (!password && process.env.OPENCODE_SERVER_PASSWORD) {
    password = process.env.OPENCODE_SERVER_PASSWORD;
  }

  if (!url) {
    url = `http://localhost:${port}`;
  }

  return { url, password };
}

const config = parseArgs();
const BASE_URL = config.url;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg: string, err?: unknown) {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[${ts}] ERROR: ${msg}`, err instanceof Error ? err.message : err ?? "");
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function getAuthHeaders(): Record<string, string> {
  if (!config.password) return {};
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const encoded = Buffer.from(`${username}:${config.password}`).toString("base64");
  return { Authorization: `Basic ${encoded}` };
}

// ---------------------------------------------------------------------------
// JSONL writer — one per session
// ---------------------------------------------------------------------------

class JsonlWriter {
  private dir: string;
  private streams = new Map<string, fs.WriteStream>();

  constructor(workspacePath: string) {
    const sanitized = workspacePath.replace(/[^a-zA-Z0-9-]/g, "-");
    this.dir = path.join(os.homedir(), ".claude", "projects", sanitized);
    fs.mkdirSync(this.dir, { recursive: true });
    log(`JSONL directory: ${this.dir}`);
  }

  /** Append a single JSONL record for a session */
  write(sessionId: string, record: unknown): void {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      const filePath = path.join(this.dir, `${sessionId}.jsonl`);
      stream = fs.createWriteStream(filePath, { flags: "a" });
      this.streams.set(sessionId, stream);
      log(`Opened JSONL file for session ${sessionId}`);
    }
    stream.write(JSON.stringify(record) + "\n");
  }

  close(): void {
    for (const [id, stream] of this.streams) {
      stream.end();
      log(`Closed JSONL stream for session ${id}`);
    }
    this.streams.clear();
  }
}

// ---------------------------------------------------------------------------
// Tool-call ID tracking
//
// OpenCode emits tool state transitions (pending -> running -> completed/error)
// but Pixel Agents expects a single tool_use record when a tool starts and
// a tool_result record when it finishes. We track which call IDs we've already
// emitted a tool_use for so we don't duplicate them.
// ---------------------------------------------------------------------------

/** Per-session state */
interface SessionState {
  /** callIDs for which we already emitted a tool_use JSONL record */
  emittedToolUse: Set<string>;
  /** callIDs for which we already emitted a tool_result JSONL record */
  emittedToolResult: Set<string>;
  /** Map callID -> tool name for subtask tracking */
  toolNames: Map<string, string>;
}

const sessions = new Map<string, SessionState>();

function getSession(sessionId: string): SessionState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      emittedToolUse: new Set(),
      emittedToolResult: new Set(),
      toolNames: new Map(),
    };
    sessions.set(sessionId, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// OpenCode event types (subset we care about)
// ---------------------------------------------------------------------------

interface ToolState {
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: unknown;
  error?: unknown;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
}

interface ToolPart {
  type: "tool";
  id: string;
  sessionID: string;
  messageID: string;
  callID: string;
  tool: string;
  state: ToolState;
}

interface TextPart {
  type: "text";
  id: string;
  sessionID: string;
  messageID: string;
  content: string;
}

interface SubtaskPart {
  type: "subtask";
  id: string;
  sessionID: string;
  messageID: string;
  prompt?: string;
  description?: string;
  agent?: string;
}

interface StepFinishPart {
  type: "step-finish";
  id: string;
  sessionID: string;
  messageID: string;
  reason?: string;
  cost?: number;
  tokens?: Record<string, unknown>;
}

type Part = ToolPart | TextPart | SubtaskPart | StepFinishPart | { type: string; [k: string]: unknown };

interface MessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  content?: string;
}

interface SSEEvent {
  type: string;
  properties: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Event translation
// ---------------------------------------------------------------------------

function handlePartUpdated(part: Part, writer: JsonlWriter): void {
  const sessionId = (part as { sessionID?: string }).sessionID;
  if (!sessionId) return;

  const state = getSession(sessionId);

  switch (part.type) {
    case "tool": {
      const tp = part as ToolPart;
      const callID = tp.callID;
      const toolName = tp.tool;

      // Map some OpenCode tool names to Claude Code equivalents if needed
      const mappedName = mapToolName(toolName);

      if (
        (tp.state.status === "running" || tp.state.status === "pending") &&
        !state.emittedToolUse.has(callID)
      ) {
        // Emit tool_use (assistant record)
        state.emittedToolUse.add(callID);
        state.toolNames.set(callID, mappedName);

        const input = normalizeInput(tp.state.input);

        writer.write(sessionId, {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: callID,
                name: mappedName,
                input,
              },
            ],
          },
        });
        log(`[${sessionId.slice(0, 8)}] tool_use: ${mappedName} (${callID.slice(0, 8)})`);
      }

      if (
        (tp.state.status === "completed" || tp.state.status === "error") &&
        !state.emittedToolResult.has(callID)
      ) {
        // Ensure we emitted tool_use first (in case we missed pending/running)
        if (!state.emittedToolUse.has(callID)) {
          state.emittedToolUse.add(callID);
          state.toolNames.set(callID, mappedName);

          const input = normalizeInput(tp.state.input);

          writer.write(sessionId, {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: callID,
                  name: mappedName,
                  input,
                },
              ],
            },
          });
          log(`[${sessionId.slice(0, 8)}] tool_use (backfill): ${mappedName} (${callID.slice(0, 8)})`);
        }

        // Emit tool_result (user record) with a small delay for animation
        state.emittedToolResult.add(callID);

        writer.write(sessionId, {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: callID,
              },
            ],
          },
        });
        log(`[${sessionId.slice(0, 8)}] tool_result: ${mappedName} (${callID.slice(0, 8)})`);
      }
      break;
    }

    case "text": {
      const tp = part as TextPart;
      if (tp.content) {
        writer.write(sessionId, {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: tp.content,
              },
            ],
          },
        });
      }
      break;
    }

    case "subtask": {
      // Subtask maps to Claude Code's "Task" tool
      const sp = part as SubtaskPart;
      const subtaskId = sp.id;

      if (!state.emittedToolUse.has(subtaskId)) {
        state.emittedToolUse.add(subtaskId);
        state.toolNames.set(subtaskId, "Task");

        writer.write(sessionId, {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: subtaskId,
                name: "Task",
                input: {
                  description: sp.description || sp.prompt || "Running subtask",
                },
              },
            ],
          },
        });
        log(`[${sessionId.slice(0, 8)}] tool_use: Task/subtask (${subtaskId.slice(0, 8)})`);
      }
      break;
    }

    case "step-finish": {
      // Emit system/turn_duration record — definitive turn end
      writer.write(sessionId, {
        type: "system",
        subtype: "turn_duration",
      });
      log(`[${sessionId.slice(0, 8)}] turn_duration (step-finish)`);

      // Clear session tool tracking for the next turn
      state.emittedToolUse.clear();
      state.emittedToolResult.clear();
      state.toolNames.clear();
      break;
    }

    default:
      // Ignore other part types (reasoning, file, snapshot, patch, etc.)
      break;
  }
}

function handleMessageUpdated(info: MessageInfo, writer: JsonlWriter): void {
  const sessionId = info.sessionID;
  if (!sessionId) return;

  if (info.role === "user") {
    // New user prompt — emit user record with string content
    const content = info.content || "";
    if (content.trim()) {
      writer.write(sessionId, {
        type: "user",
        message: {
          content,
        },
      });
      log(`[${sessionId.slice(0, 8)}] user prompt`);

      // Clear tool tracking — new turn
      const state = getSession(sessionId);
      state.emittedToolUse.clear();
      state.emittedToolResult.clear();
      state.toolNames.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Tool name mapping
// ---------------------------------------------------------------------------

/** Map OpenCode tool names to Claude Code equivalents where they differ */
function mapToolName(name: string): string {
  // Most OpenCode tools share names with Claude Code tools.
  // Add explicit mappings here if any diverge.
  const MAP: Record<string, string> = {
    // OpenCode uses the same names: Read, Edit, Write, Bash, Glob, Grep,
    // WebFetch, Task, etc. — no mapping needed currently.
  };
  return MAP[name] ?? name;
}

/** Normalize tool input to a plain object */
function normalizeInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // not JSON
    }
    return { command: input };
  }
  return {};
}

// ---------------------------------------------------------------------------
// SSE client with auto-reconnect
// ---------------------------------------------------------------------------

async function connectSSE(writer: JsonlWriter): Promise<void> {
  const url = `${BASE_URL}/event`;
  log(`Connecting to SSE: ${url}`);

  while (true) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/event-stream", ...getAuthHeaders() },
        // No signal/timeout — SSE connection stays open indefinitely
      });

      if (!response.ok) {
        logError(`SSE HTTP ${response.status}: ${response.statusText}`);
        await delay(3000);
        continue;
      }

      if (!response.body) {
        logError("SSE response has no body");
        await delay(3000);
        continue;
      }

      log("SSE connected");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          log("SSE stream ended");
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // SSE lines are separated by \n\n for events
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const eventBlock of parts) {
          processSSEBlock(eventBlock, writer);
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        // expected for timeout
      } else {
        logError("SSE connection error", err);
      }
    }

    log("Reconnecting in 3s...");
    await delay(3000);
  }
}

function processSSEBlock(block: string, writer: JsonlWriter): void {
  const lines = block.split("\n");
  let data = "";

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      data += line.slice(6);
    } else if (line.startsWith("data:")) {
      data += line.slice(5);
    }
    // ignore event:, id:, retry: lines
  }

  if (!data) return;

  let event: SSEEvent;
  try {
    event = JSON.parse(data);
  } catch {
    // not valid JSON, skip
    return;
  }

  try {
    routeEvent(event, writer);
  } catch (err) {
    logError(`Error processing event ${event.type}`, err);
  }
}

function routeEvent(event: SSEEvent, writer: JsonlWriter): void {
  switch (event.type) {
    case "message.part.updated": {
      const part = event.properties.part as Part | undefined;
      if (part) {
        handlePartUpdated(part, writer);
      }
      break;
    }

    case "message.updated": {
      const info = event.properties.info as MessageInfo | undefined;
      if (info) {
        handleMessageUpdated(info, writer);
      }
      break;
    }

    case "server.connected":
      log("Received server.connected event");
      break;

    case "server.heartbeat":
      // silent
      break;

    default:
      // Ignore unknown events
      break;
  }
}

// ---------------------------------------------------------------------------
// Workspace path discovery
// ---------------------------------------------------------------------------

async function discoverWorkspacePath(): Promise<string> {
  // OpenCode's GET /path returns:
  // { home, state, config, worktree, directory }
  // We want "directory" (the project working directory) or "worktree" (git root)
  try {
    const resp = await fetch(`${BASE_URL}/path`, {
      headers: { ...getAuthHeaders() },
    });
    if (resp.ok) {
      const json = await resp.json() as Record<string, string>;
      // Prefer "directory" (actual working dir), fall back to "worktree" (git root)
      const result = json.directory || json.worktree;
      if (result) {
        log(`Discovered workspace from /path: ${result}`);
        return result;
      }
    }
  } catch {
    // endpoint not available
  }

  // Fallback: try /project/current for the worktree path
  try {
    const resp = await fetch(`${BASE_URL}/project/current`, {
      headers: { ...getAuthHeaders() },
    });
    if (resp.ok) {
      const json = await resp.json() as Record<string, unknown>;
      if (typeof json.worktree === "string" && json.worktree) {
        log(`Discovered workspace from /project/current: ${json.worktree}`);
        return json.worktree;
      }
    }
  } catch {
    // endpoint not available
  }

  // Last fallback: use current working directory
  log("Could not discover workspace path from OpenCode, using CWD");
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOpenCode(): Promise<void> {
  log(`Waiting for OpenCode server at ${BASE_URL}...`);
  while (true) {
    try {
      const resp = await fetch(`${BASE_URL}/event`, {
        method: "GET",
        headers: { Accept: "text/event-stream", ...getAuthHeaders() },
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        // Consume body to avoid leaking
        try {
          resp.body?.cancel();
        } catch {
          // ignore
        }
        log("OpenCode server is reachable");
        return;
      }
    } catch {
      // not up yet
    }
    await delay(2000);
  }
}

async function main(): Promise<void> {
  console.log("=== Pixel Agents Bridge for OpenCode ===");
  console.log(`Server: ${BASE_URL}`);
  if (config.password) console.log("Auth:   Basic (password set)");
  console.log();

  // Wait for OpenCode to be available
  await waitForOpenCode();

  // Discover workspace path
  const workspacePath = await discoverWorkspacePath();
  log(`Workspace path: ${workspacePath}`);

  // Create JSONL writer
  const writer = new JsonlWriter(workspacePath);

  // Graceful shutdown
  const shutdown = () => {
    log("Shutting down...");
    writer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Connect to SSE and start translating
  await connectSSE(writer);
}

main().catch((err) => {
  logError("Fatal error", err);
  process.exit(1);
});
