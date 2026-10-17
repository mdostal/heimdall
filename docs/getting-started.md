---
title: Getting Started
nav_order: 2
---

# Getting Started
{: .no_toc }

<details open markdown="block">
  <summary>Table of contents</summary>
  {: .text-delta }
1. TOC
{:toc}
</details>

## Prerequisites

- **Node.js** >= 22.5.0 (Heimdall uses `node:sqlite`, which landed in 22.5.0)
- A running [Multica](https://github.com/mdostal/pantheon-v2) workspace (for autopilot scheduling and actuation)
- At least one LLM API credential (Claude, Codex, Gemini, Kimi, OpenRouter, or a local Ollama instance)

## Install

### Option 1 — Clone and run locally

```bash
git clone https://github.com/mdostal/heimdall.git
cd heimdall
npm install
```

### Option 2 — Install from npm (when published)

```bash
npm install -g @mdostal/heimdall
```

The `heimdall` binary is then available globally.

## First-time setup

### 1. Create your `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in at least one lane. Example for a single Claude lane:

```dotenv
HEIMDALL_LANE_1_ID=claude@you
HEIMDALL_LANE_1_PROVIDER=claude
HEIMDALL_LANE_1_MODEL=claude-sonnet
HEIMDALL_LANE_1_CREDENTIAL_REF=MY_CLAUDE_TOKEN
MY_CLAUDE_TOKEN=sk-ant-...
```

See the [Configuration Reference](configuration.md) for the full list of env vars.

### 2. Configure the Multica autopilot agent

Heimdall's coarse scheduler dispatches a Multica autopilot to trigger lane refresh. Set the agent name:

```dotenv
MULTICA_AUTOPILOT_AGENT=dostal-dev   # any existing agent ID in your workspace
```

### 3. Register the MCP server (optional but recommended)

If you want LLM agents to query Heimdall directly via MCP:

**Claude Code:**
```bash
claude mcp add heimdall -- node /path/to/heimdall/bin/heimdall-mcp.js
```

**Codex:**
```bash
codex mcp add heimdall node /path/to/heimdall/bin/heimdall-mcp.js
```

Or use the built-in agent setup command:
```bash
npx heimdall agent init
```

## Start the service

```bash
npm run dev          # development mode (tsx watch)
npm start            # compiled JS
```

The service binds to `http://localhost:4870` by default. Override with `PORT=<n>` in `.env`.

Verify it's running:
```bash
curl http://localhost:4870/healthz
# {"ok":true}
```

Check lane status:
```bash
curl http://localhost:4870/lanes
```

## Quick smoke test

```bash
# Get a route for a task
curl -X POST http://localhost:4870/route \
  -H 'Content-Type: application/json' \
  -d '{"task_id":"smoke-01","task_type":"code"}'
```

A response like `{"chosen_lane":"claude@you","rationale":"..."}` means everything is wired up.

## Next steps

- [Configuration Reference](configuration.md) — tune every knob
- [Lane Management](lane-management.md) — add more lanes, override health
- [Operations Guide](operations.md) — run in production
