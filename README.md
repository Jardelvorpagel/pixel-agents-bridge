# Pixel Agents Bridge for OpenCode

Translates [OpenCode](https://github.com/anomalyco/opencode)'s SSE events into Claude Code-compatible JSONL files so the [Pixel Agents](https://github.com/pablodelucca/pixel-agents) VS Code extension works with OpenCode — no modifications needed to either project.

## How it works

```
OpenCode (SSE /event) → Bridge (translate) → JSONL files → Pixel Agents (VS Code)
```

1. The bridge connects to OpenCode's HTTP server SSE endpoint
2. It translates events (tool calls, text, subtasks, turn ends) into Claude Code's JSONL format
3. JSONL files are written to `~/.claude/projects/<sanitized-path>/<session>.jsonl`
4. Pixel Agents picks up new JSONL files automatically and shows animated agents

## Prerequisites

- [OpenCode](https://github.com/anomalyco/opencode) installed
- [Node.js](https://nodejs.org/) 18+ (or [Bun](https://bun.sh/))
- [Pixel Agents](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) VS Code extension installed
- A terminal open in VS Code (Pixel Agents needs an active terminal to adopt)

## Quick start

### 1. Start OpenCode with the HTTP server enabled

OpenCode doesn't start its HTTP server by default. Use the `--port` flag:

```bash
# TUI with server on port 4096
opencode --port 4096

# Or headless server only
opencode serve --port 4096

# Or web UI + server
opencode web --port 4096
```

### 2. Start the bridge (in a separate terminal)

```bash
cd ~/Projects/pixel-agents-bridge
npm start
```

That's it. The bridge will connect, discover the workspace, and start writing JSONL files. Open VS Code with a terminal and you should see pixel agents appear.

## Options

```
npx tsx bridge.ts [options]

  --port <port>       Port of the OpenCode server (default: 4096)
  --url <url>         Full URL of the OpenCode server (overrides --port)
  --password <pass>   Basic auth password (if OPENCODE_SERVER_PASSWORD is set)
  --help, -h          Show help
```

The bridge also reads `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_USERNAME` environment variables.

### Examples

```bash
# Connect to default port 4096
npx tsx bridge.ts

# Connect to custom port
npx tsx bridge.ts --port 8080

# Connect to remote server
npx tsx bridge.ts --url http://192.168.1.10:4096

# With auth
npx tsx bridge.ts --port 4096 --password mysecret
```

## Making it permanent (optional)

If you want the server to always start with the TUI, add `server.port` to your OpenCode config:

```jsonc
// ~/.config/opencode/opencode.json
{
  "server": {
    "port": 4096
  }
}
```

## How the translation works

| OpenCode Event | JSONL Record | Pixel Agents Effect |
|---|---|---|
| Tool running/pending | `assistant` + `tool_use` | Active animation (typing, searching, etc.) |
| Tool completed/error | `user` + `tool_result` | Clears tool state |
| Text output | `assistant` + `text` | 5s idle timer |
| Subtask | `assistant` + `Task` tool_use | Sub-agent activity |
| Step finish | `system` / `turn_duration` | Agent goes to waiting state |
| User message | `user` + string content | Clears all activity |

## Troubleshooting

**Bridge prints "Waiting for OpenCode server..."**
- Make sure OpenCode is running with `--port 4096` (or whichever port you chose)
- Check that the port isn't blocked: `curl http://localhost:4096/path`

**Pixel Agents doesn't show any agent**
- Make sure you have at least one terminal open in VS Code
- Check that the Pixel Agents extension is installed and the panel is visible
- The JSONL file must be *new* — if you restart the bridge, it creates a new session file automatically

**Auth errors (401)**
- If OpenCode has `OPENCODE_SERVER_PASSWORD` set, pass it to the bridge: `--password <pass>`

## GitHub OpenCode workflow

This repo also includes `.github/workflows/opencode.yml` so OpenCode can run from GitHub comments and update the related issue or PR.

- Trigger it by adding a new comment with `/oc` or `/opencode` on an issue, a PR conversation, or an inline PR review comment.
- On PR comments, the workflow resolves and checks out the PR head commit so OpenCode runs against the proposed changes instead of default-branch code.
- The workflow keeps `contents` read-only, adds `models: read` for the configured GitHub Models backend, and grants only `issues: write` and `pull-requests: write` for issue/PR updates.
- If the workflow cannot write back to GitHub, check the repository's **Settings → Actions → General → Workflow permissions** and make sure `GITHUB_TOKEN` is allowed to have read and write access.

## Architecture

```
┌─────────────┐     SSE /event      ┌─────────────┐    JSONL files     ┌──────────────┐
│  OpenCode   │ ──────────────────→ │   Bridge    │ ─────────────────→ │ Pixel Agents │
│  (server)   │                     │ (bridge.ts) │                    │  (VS Code)   │
│             │ ← GET /path ─────── │             │                    │              │
└─────────────┘                     └─────────────┘                    └──────────────┘
     port 4096                    ~/.claude/projects/                   file watcher
```
