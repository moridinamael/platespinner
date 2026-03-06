# Plugins

Place JavaScript plugin files in this directory. They are loaded automatically at server startup.

## Plugin Contract

Each plugin is a `.js` file (or a directory with `index.js`) that exports an `activate(context)` function:

```javascript
export const name = 'my-plugin';       // optional, defaults to filename
export const version = '1.0.0';        // optional
export const description = 'What it does';  // optional

export function activate(context) {
  // Register hooks, tools, validators, etc.
}
```

## Context API

The `context` object provides:

### Hooks

```javascript
context.registerPreExecutionHook(name, handler, { priority })
context.registerPostExecutionHook(name, handler, { priority })
context.registerPostPlanningHook(name, handler, { priority })
```

Hooks run in priority order (lower = earlier, default 100). Handlers receive `{ task, project, result }`.

### Task Validators

```javascript
context.registerTaskValidator(name, handler, { priority })
```

Validators run before marking a task as done. Return `{ valid: true }` or `{ valid: false, message: '...' }`. If any validator rejects, the task reverts to its previous status.

### Custom Tools

```javascript
context.registerTool(name, { description, allowedPhases: ['execution'], handler })
```

Registers tool names to include in the Claude CLI `--allowedTools` flag. Tools must be available via MCP servers.

### Custom Parsers

```javascript
context.registerParser(name, { phase: 'execution', priority, handler })
```

Custom parsers receive `(stdout, phase)` and return a parsed result or `null` to pass to the next parser.

### Events

```javascript
context.on(eventName, handler)
```

Subscribe to system events: `execution:completed`, `execution:failed`, `planning:completed`, `generation:completed`.

### Utilities

```javascript
context.getProject(id)   // Read-only project access
context.getTask(id)      // Read-only task access
context.broadcast(event, data)  // Emit WebSocket event
context.log(message)     // Plugin-scoped console logging
```

## Example Plugins

- **lint-on-commit.js** — Runs ESLint after each execution commit
- **changelog-updater.js** — Appends task summaries to CHANGELOG.md
- **notify-webhook.js** — Sends webhook notifications on execution events
- **require-tests-pass.js** — Validates tests pass before marking tasks done

## Notes

- Plugins load once at startup. Changes require a server restart.
- Plugin errors are caught and logged — they never crash the server.
- Place user-specific plugins that shouldn't be committed in `plugins/local/`.
