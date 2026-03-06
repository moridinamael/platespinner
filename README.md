# PlateSpinner

AI-powered kanban board that uses CLI tools (Claude Code, Codex, Gemini) to generate, plan, and execute development tasks against your local projects. Spin up autonomous agents and watch them work.

<!-- ![Screenshot](screenshot.png) -->

## Features

- **AI-powered task generation** — describe what you want built, get a structured task list
- **Automated planning and execution** — AI agents plan implementation steps and execute them
- **Drag-and-drop kanban board** — organize and prioritize tasks visually
- **Dark and light themes** — toggle between themes to suit your preference
- **Command palette and keyboard shortcuts** — fast navigation and actions
- **Real-time WebSocket updates** — live progress streaming during agent execution
- **Diff viewer** — review AI-generated code changes before committing
- **Agent replay and debugging** — inspect full agent output and reasoning
- **Notification integrations** — Slack, Discord, email, and webhook support
- **Plugin system** — extend functionality with custom hooks, tools, parsers, and validators
- **Batch operations** — select and act on multiple tasks at once
- **Test framework detection** — automatically discovers and runs your project's tests

## Prerequisites

- **Node.js 18+**
- At least one AI CLI tool installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (recommended — used for task generation and execution)
  - [Codex CLI](https://github.com/openai/codex) (optional)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) (optional)

## Quick Start

```bash
git clone https://github.com/moridinamael/platespinner.git
cd kanban-interface
npm install
npm start
```

Then open [http://localhost:3001](http://localhost:3001).

## Development

Run the frontend (Vite) and backend (Express) concurrently with hot reload:

```bash
npm run dev
```

- Frontend: `http://localhost:5173` (proxies API/WebSocket to backend)
- Backend: `http://localhost:3001`

Run tests:

```bash
npm test
```

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `RAILWAY_BIN` | `railway` | Path to Railway CLI binary |
| `DEBUG_AUTOCLICKER` | off | Enable debug logging for autoclicker judgment agent |

## Architecture

```
src/           → React frontend (Vite)
server/        → Express backend
  agents/      → AI CLI spawning (generation, planning, execution)
  routes/      → REST API endpoints
  state.js     → JSON file-based persistence (data/state.json)
  ws.js        → WebSocket for real-time updates
  testing.js   → Test framework detection and execution
  paths.js     → Cross-platform path handling (WSL support)
plugins/       → Plugin directory (loaded at startup)
data/          → Runtime data (gitignored, auto-created)
```

## How It Works

1. **Add a project** — point to a local directory containing your codebase
2. **Generate tasks** — describe your goal and AI creates a structured task list
3. **Plan each task** — AI breaks tasks into concrete implementation steps
4. **Execute with an agent** — AI writes code, runs tests, and commits changes
5. **Review and push** — inspect diffs, approve changes, and push to your repo

## Plugin System

Plugins extend the server with custom hooks, tools, parsers, and validators. Place `.js` files in the `plugins/` directory and they load automatically at startup.

See [plugins/README.md](plugins/README.md) for the full API reference.

## License

[MIT](LICENSE)
