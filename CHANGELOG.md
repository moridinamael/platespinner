# Changelog

### 2026-04-16 — Replace full-state JSON serialization with incremental per-collection writes

Refactor server/state.js persistence to split the monolithic data/state.json into per-collection files (projects.json, tasks.json, promptTemplates.json, notificationSettings.json, executionQueues.json, autoclickerConfig.json, autoclickerAuditLog.json). Track a dirty-collections Set and only serialize/write the collections that actually changed on each debounced flush; tag every save() call site with the specific collections it mutates (e.g. addTask dirties only 'tasks', enqueueTask dirties 'tasks' + 'executionQueues'). Preserve atomic write semantics (temp → fsync → backup → rename) per-collection, graceful-shutdown flushing, and backward compatibility via automatic one-time migration from the legacy state.json on first load. The legacy file is left on disk as a rollback safety net. Previously every task status change serialized 25K+ lines of JSON; now a task update rewrites only tasks.json.

### 2026-04-16 — Make Rank button per-project instead of column-wide

Refactor the Rank button in src/components/Column.jsx (lines 26-39) and its handler handleRankProposals in src/hooks/useTasks.js (lines 316-326) so that ranking is scoped per project. Currently the Rank button sits in the 'proposed' column header and (1) calls api.rankProposals for every project that has ≥2 proposed tasks and (2) disables whenever any single project in rankingMap is ranking (see Column.jsx:7 `rankingInProgress = tasks.some(t => rankingMap[t.projectId])`). Change this so each project with ≥2 proposed tasks gets its own Rank button, most naturally by grouping proposed tasks by project inside the 'proposed' column with a small per-project subheader containing a Rank button. The button's disabled state should check only `rankingMap[thatProjectId]`, and onRankProposals should accept a projectId argument and call api.rankProposals(projectId) for just that project. Plumb the projectId through from Column.jsx to the handler (update KanbanBoard.jsx:128 pass-through and App.jsx:425 binding). Remove the `projectIds` fan-out inside handleRankProposals so it ranks one project at a time. Ensure the spinner label on the button reflects only that project's ranking state.

Commit: `eb49c84`

### 2026-04-15 — Add per-project activity filtering in the sidebar

In the existing sidebar project list, add a small activity indicator (dot or count badge) next to each project name showing how many unread completions that project has. Clicking the indicator filters the ActivityFeed to show only that project's recent completions. This reuses the `useActivityFeed` hook with a `projectId` filter parameter.

Commit: `a2260d8`

### 2026-04-15 — Add keyboard shortcut and command palette integration

Register a keyboard shortcut (e.g., `Ctrl+Shift+A` or `A` when no input focused) to toggle the ActivityFeed panel. Also add an 'Activity Feed' entry to the existing Command Palette (`Ctrl+K`) so users can open it by searching. Add entries for 'Show recent completions' and 'Show unread activity' as palette actions.

Commit: `e4e369b`

### 2026-04-15 — Build ActivityFeed panel component

Create `/src/components/ActivityFeed.jsx` — a slide-out panel or collapsible drawer anchored to the right edge of the screen (or bottom-right corner). Each entry shows: colored icon by event type (plan/execute/rank/generate), task title (clickable to open card modal), project name badge, relative timestamp ('2m ago'), status indicator (success/failed), cost, and a one-click action button matching the `suggestedAction` (e.g., 'Execute' for a newly planned task, 'Review Diff' for done, 'Retry' for failed). Include a bell/notification icon in the top nav bar showing the unread count badge. Clicking it toggles the panel. Style consistently with the existing sidebar and card modal aesthetics.

Commit: `09ca4d9`

### 2026-04-15 — Create useActivityFeed React hook

Add `/src/hooks/useActivityFeed.js` that: (1) fetches initial recent activity from `GET /api/activity?limit=50` on mount, (2) subscribes to `activity:completed` WebSocket events via the existing `useWebSocket` hook to prepend new entries in real-time, (3) exposes `activities`, `unreadCount`, `markAllRead`, and `dismissEntry` state. Track a `lastSeenTimestamp` in localStorage so unread count persists across page refreshes. Activities older than 24 hours should auto-fade from the feed (but remain fetchable from the API).

Commit: `d17c372`

### 2026-04-15 — Broadcast activity-log entries over WebSocket

When the activity log captures a new completion event, broadcast an `activity:completed` WebSocket message containing the log entry. This leverages the existing `ws.js` broadcast infrastructure. The frontend can subscribe to this single event type instead of listening to 5+ separate completion events. Include a `suggestedAction` field in each entry (e.g., 'Review plan and execute', 'Check diff and merge', 'Retry or dismiss', 'Review rankings') so the UI can show an actionable next-step hint.

Commit: `909a5d9`

### 2026-04-15 — Add server-side activity log for completed events

Create a new module at `/server/activityLog.js` that captures completion events (generation, planning, execution, judgment, ranking) into a bounded in-memory ring buffer (e.g., last 100 entries) that also persists to `data/activity-log.json`. Each entry should record: timestamp, event type (generation/planning/execution/ranking/judgment), task ID, task title, project ID, project name, status (success/failed), cost, and duration. Hook into the existing notification emission points in `state.js` (around lines 691-733) and the completion handlers in `routes/tasks.js` where `execution:completed`, `planning:completed`, etc. are broadcast. Expose a GET `/api/activity` endpoint with optional `?since=<timestamp>&limit=<n>` query params.

Commit: `d68fc57`

### 2026-04-15 — Eliminate data/ directory from repo, add to .gitignore

data/state.json (25,172 lines) and data/state.backup.json (25,172 lines) are checked into git or at minimum sitting in the working directory at 50K+ lines. These are runtime artifacts — user-specific task data, project configs, execution logs. They should be in .gitignore. Every git operation (status, diff, add) is scanning 50K lines of JSON that has nothing to do with the source code. Add data/ to .gitignore and document that state is created on first run.

Commit: `57f3441`

### 2026-04-15 — Extract WebSocket event handler from App.jsx into a dedicated hook

The handleWsMessage callback in App.jsx (lines ~195-400+) is a massive switch statement covering 25+ event types that directly calls 10+ setState functions. Extract it into a custom useWebSocket(wsRef, dispatchers) hook that receives setter references and returns connection status. This moves ~200 lines out of App.jsx, makes the event handling testable in isolation, and clarifies the data flow. The dispatchers object groups related setters (tasks, projects, progress, status) making the coupling explicit.

Commit: `c0dbea5`

### 2026-04-15 — Extract hooks and logic from App.jsx

App.jsx is 1309 lines acting as both state manager and UI root. Extract custom hooks for each concern: useProjects (CRUD + reorder), useTasks (CRUD + filtering + WebSocket sync), useTheme (theme state + persistence), useWebSocket (connection lifecycle + event dispatch), and useKeyboardShortcuts. Keep App.jsx as a thin shell that composes these hooks and renders the layout. This can be done incrementally — one hook at a time — without changing any behavior.

Commit: `da48f54`

### 2026-04-15 — Replace silent .catch(() => {}) with error logging

At least 8 locations across App.jsx (lines 130, 558), Sidebar.jsx (lines 207, 208, 262, 277), and CardModal.jsx (lines 105, 125) silently swallow promise rejections with .catch(() => {}). Replace each with .catch(err => console.warn('context:', err)) at minimum, and where appropriate, set error UI states (e.g., show 'Failed to load git status' instead of blank).

Commit: `44b0f92`

### 2026-04-15 — Use existing checkBudget() from runner.js in route handlers

runner.js already has a clean `checkBudget(project)` function (line 247) that returns `{ allowed, totalSpent, limit }`. But routes/tasks.js duplicates this logic inline in two places: the single-execute endpoint (lines 130-148) and the batch-execute loop (lines 471-476). Both independently compute `getTasks → reduce → compare`. Replace both with an import of `checkBudget` (or move it to state.js as `getProjectTotalSpent`). The single-execute path would become: `const budget = checkBudget(project); if (!budget.allowed) { emitNotification(...); return res.status(400)... }`. The batch path would become: `if (!checkBudget(project).allowed) continue;`.

Commit: `eac9dcd`

### 2026-04-15 — Add ranking progress feedback via WebSocket events

Follow the same pattern as generation progress: broadcast `ranking:started { projectId }`, `ranking:progress { projectId, bytesReceived }`, and `ranking:completed { projectId, rankedCount, costUsd }` or `ranking:failed { projectId, error }` events. In the frontend, listen for these in `App.jsx`'s WebSocket handler to update a `rankingInProgress` state map (keyed by projectId). Pass this state to Column/KanbanBoard so the Rank button shows a spinner/progress indicator while the LLM is working. This prevents double-clicks and gives the user confidence something is happening, since ranking may take 30-60 seconds depending on the number of proposals and codebase size.

Commit: `9693610`

### 2026-04-13 — Display ranking reasoning as tooltips or badges on ranked cards

After ranking completes, store the per-task reasoning and score from the LLM response. Two options: (A) Save to a new `rankingScore` and `rankingReason` field on each task (requires adding to the task schema in `state.js` addTask/updateTask), or (B) store transiently in frontend state only (simpler, but lost on refresh). Recommended: option A for persistence. In `Card.jsx`, when `rankingScore` is present, show a small badge or overlay (e.g., '#1', '#2') and a tooltip on hover showing the reasoning. This helps the user understand *why* tasks were ranked this way and decide whether to accept the ranking or manually reorder.

Commit: `52c06c3`

### 2026-04-13 — Add 'Rank Proposals' button to the Proposed column header

In `src/components/Column.jsx`, add a 'Rank' button in the Proposed column header (alongside the existing 'Plan All' button, line 20-24). The button should call a new `onRankProposals` prop. In `src/components/KanbanBoard.jsx`, thread this prop through from `App.jsx`. In `App.jsx`, implement the handler: call `api.rankProposals(projectId, modelId)`, show a loading state on the button (spinning icon or 'Ranking...' text), and on completion the reordered tasks arrive via the existing `tasks:reordered` WebSocket event which already triggers a re-render with updated sortOrder. Add the API client method `rankProposals: (projectId, modelId) => request('POST', `/projects/${projectId}/rank-proposals`, { modelId })` to `src/api.js`. The button should be disabled when there are fewer than 2 proposed tasks (ranking 0-1 tasks is pointless) or when a ranking is already in progress. If the board is filtered to a specific project, use that projectId; if showing all projects, show a dropdown or rank per-project.

Commit: `2f8b7c0`

### 2026-04-13 — Add backend ranking endpoint that spawns an LLM to rank proposed tasks

Create a new POST endpoint at `/api/projects/:id/rank-proposals` in `server/routes/tasks.js` (or a new route file). This endpoint gathers all proposed tasks for the given project, builds a ranking prompt, spawns a read-only LLM agent (using the same `buildGenerationCommand` + `spawnAgent` pattern from `runner.js`), and parses the ranked output. The prompt should instruct the LLM to: (1) analyze the project directory via Read/Glob/Grep tools to infer the project's purpose/telos/CEV, (2) evaluate each proposed task's title, description, and rationale against that inferred purpose, (3) return a JSON array of task IDs ordered from most valuable to least, with optional reasoning per task. On success, the endpoint updates each task's `sortOrder` field via `state.reorderTasks()` to reflect the ranking, broadcasts `tasks:reordered` over WebSocket, and returns the ranked order. Should accept an optional `modelId` parameter. The prompt template should be a new skill file `server/skills/rank-proposals.md` to keep it editable and consistent with existing skill conventions. Add a new `buildRankingCommand` to `cli.js` that mirrors `buildGenerationCommand` (read-only tools only). Add a new `runRanking` function in `runner.js` (or a new `ranker.js`) following the same pattern as `runGeneration`: spawn agent, extract cost data, parse output from `<ranking-result>` tags, write replay events. Track cost in a new `tokenUsage.ranking` field on each affected task (split evenly).

Commit: `c37df74`

### 2026-04-13 — Create rank-proposals.md skill prompt that infers project telos and scores tasks

Write `server/skills/rank-proposals.md` — the prompt template that the ranking agent receives. Structure: (1) Instruct the agent to explore the project directory, README, package.json/pyproject.toml, git log, and existing done/executing tasks to infer the project's purpose, goals, and coherent extrapolated volition (CEV). (2) Present the list of proposed tasks (title, description, rationale, effort) as a numbered list. (3) Ask the agent to score each task on criteria like: alignment with project telos, expected impact, feasibility given codebase state, effort-to-value ratio, and whether it addresses a real gap vs. speculative improvement. (4) Output format: `<ranking-result>[{"taskId": "...", "rank": 1, "score": 0.92, "reasoning": "..."}]</ranking-result>`. Include guidance that the agent should penalize tasks that duplicate existing work, are too vague, or solve problems the project doesn't have.

Commit: `a137ed6`

### 2026-04-13 — Generic counter helper for autoclicker Maps in state.js

In state.js, lines 614-636 define six nearly identical functions: get/increment/reset for `autoclickerCycleCount` and `autoclickerConsecutiveFailures`. Each triplet follows the same pattern: `map.get(id) || 0`, `map.set(id, (map.get(id) || 0) + 1)`, `map.delete(id)`. Create a `makeCounter(map)` factory that returns `{ get(id), increment(id), reset(id) }`, then: `const cycleCounter = makeCounter(autoclickerCycleCount); export const getAutoclickerCycleCount = cycleCounter.get; ...` (preserving the same export names for backward compatibility).

Commit: `56c5293`

### 2026-04-13 — Consolidate getModelLabelForTask and getModelProviderForTask

In src/utils.js, `getModelLabelForTask` (line 46) and `getModelProviderForTask` (line 63) both call `resolveTaskModelId(task)` then perform a model lookup — duplicating the resolve-then-find pattern. Merge into a single `resolveTaskModel(task, models)` that returns `{ modelId, label, provider }` in one pass. Card.jsx (the only consumer of both) would call it once: `const { label: modelLabel, provider: modelProvider } = resolveTaskModel(task, models)`. The standalone `getModelLabel` and `getModelProvider` functions (used by CardModal.jsx for per-phase lookups) remain unchanged.

Commit: `92412ef`

### 2026-03-13 — Add integration tests for the generate-plan-execute pipeline

The most critical code path — runner.js's runGeneration(), runPlanning(), and runExecution() — has zero test coverage. The existing 10 test files cover parser edge cases and state operations but never test the actual orchestration that spawns agents, parses output, updates state, and broadcasts events. Create server/agents/runner.test.js with tests that mock child_process.spawn and verify: (1) correct CLI command construction per model, (2) state transitions on success/failure, (3) queue advancement after execution completes, (4) timeout handling, (5) log file creation and replay event recording.

Commit: `3a7f249`

### 2026-03-07 — Add Express middleware for common route validation

Create a small middleware layer that handles the repeated project-not-found (14 instances) and task-not-found (13 instances) validation patterns across server/routes/projects.js and server/routes/tasks.js. Implement `resolveProject` and `resolveTask` param middleware using `router.param()` that attaches the entity to `req.project` / `req.task` or returns 404. This eliminates ~27 duplicate validation blocks and centralizes error responses. Also add a lightweight `validateBody(schema)` middleware using a simple schema object (no library needed) to validate required fields and types on POST/PATCH handlers — currently request bodies are consumed without any type or presence checks, allowing NaN budgets, undefined strategies, and invalid model IDs.

Commit: `1071e84`

### 2026-03-07 — Fix O(n²) queue hydration and mutating sorts in KanbanBoard

In src/App.jsx lines 146-152, queue hydration uses `.find()` inside `.map()` creating O(n²) lookups — convert queues to a Map keyed by taskId before the loop for O(n) hydration. In src/components/KanbanBoard.jsx lines 28-45, `tasksByColumn` sorts arrays in-place inside a useMemo, which mutates the memoized object and breaks React identity checks for downstream memo'd components. Fix by sorting copies (`[...arr].sort(...)`) or sorting before insertion. These two fixes together eliminate the most impactful frontend performance bottlenecks for boards with 100+ tasks.

Commit: `3245e79`

### 2026-03-07 — Add API route handler tests for critical task endpoints

The test suite covers state management, parsing, and utilities but has zero tests for API route handlers. Add integration tests for the most critical endpoints: POST /api/generate (validates project exists, returns proper errors), PATCH /api/tasks/:id (validates input, rejects invalid transitions), POST /api/tasks/:id/execute (checks project lock, budget limits), and DELETE /api/tasks/:id (verifies running tasks are aborted first). Use Vitest with a lightweight Express test helper or supertest.

Commit: `8346b46`

### 2026-03-07 — Extract status transition guards into a reusable module

In server/routes/tasks.js, status validation is duplicated across 5+ route handlers with inconsistent patterns (lines 45, 104, 123, 172, 221). Create a server/taskStateMachine.js module that defines valid transitions (e.g., 'proposed' can transition to 'planning' or 'queued', 'failed' can transition to 'proposed' via retry) and exports guard functions like canPlan(task), canExecute(task), canDismiss(task). Replace inline checks with these guards.

Commit: `8f45c96`

### 2026-03-07 — Add input validation to task PATCH endpoint

In server/routes/tasks.js (lines 49-63), the PATCH /api/tasks/:id endpoint accepts any value for editable fields without type checking, length limits, or sanitization. Add validation: title must be a non-empty string under 500 chars, description under 10,000 chars, effort must be one of 'small'|'medium'|'large', plan must be an object or null. Return 400 with specific validation errors on failure.

Commit: `6fe71bf`

### 2026-03-07 — Extract EXTRA_PATH_DIRS constant to shared module

The `EXTRA_PATH_DIRS` constant (an array of `~/go/bin`, `~/.cargo/bin`, `~/.local/bin`, `~/.npm-global/bin` joined with ':') is defined identically in both `server/testing.js` (line 8-13) and `server/agents/runner.js` (line 137-142). Extract it to `server/paths.js` (which already exists and is imported by both files) and import from there.

Commit: `c7746df`

### 2026-03-07 — Add rate limiting to broadcast-heavy WebSocket events

The server emits 99 broadcast() calls across 11 files, with the highest-frequency ones being execution:progress (every stdout chunk from agent), execution:git (every 10s per task), and planning:progress. Each broadcast serializes the full payload to JSON and writes it to every connected WebSocket client. Add a throttle wrapper for high-frequency events: broadcastThrottled(event, data, intervalMs) that coalesces rapid-fire updates into at most one send per interval (e.g., 200ms for progress, 5s for git stats). The client already batches these via pendingProgressRef — matching server-side throttling removes redundant serialization.

Commit: `307e208`

### 2026-03-07 — Reduce git polling overhead during task execution

pollGitStatus() in runner.js spawns two child processes (git diff --stat + git ls-files) every 10 seconds per executing task. With 3-5 concurrent tasks, that's 6-10 git processes every 10s, each reading the full index. Improvements: (1) Increase interval to 30s — the UI already shows real-time agent output, so git stats are supplementary. (2) Combine both git commands into a single shell invocation. (3) Skip polling for tasks in worktrees where the parent repo hasn't changed. (4) Add a debounce so rapid task starts don't all poll simultaneously.

Commit: `3cfcb4b`

### 2026-03-07 — Surface API errors to the user instead of swallowing them

There are 20+ instances across App.jsx and Sidebar.jsx of .catch(console.error) or .catch(() => {}) on API calls. When operations like planTask, executeTask, dismissTask, or runTests fail, the user sees nothing — the UI just silently doesn't change. Add a lightweight toast/snackbar notification system (the statusMessage state already exists) and replace silent catches with user-visible error messages. Key targets: lines 126-153 in App.jsx (initial data load), all task action handlers, and notification test calls.

Commit: `8d60016`

### 2026-03-07 — Replace window token injection with HttpOnly cookie auth

When APP_API_TOKEN is set, the server injects it into HTML as window.__APP_API_TOKEN__ making it accessible to any JS on the page. Replace with: (1) Add a POST /api/auth endpoint that sets an HttpOnly, SameSite=Strict cookie; (2) Modify the auth middleware to check the cookie in addition to Bearer header; (3) Add a login prompt in the frontend when token auth is enabled but no cookie is present; (4) Remove the HTML injection from server/index.js. Keep Bearer token support for API/CLI consumers.

Commit: `1f2d7fd`

### 2026-03-07 — Add tests for the agent runner execution engine

server/agents/runner.js (993 lines) has zero test coverage despite being the core execution engine. Create server/agents/runner.test.js covering: (1) runGeneration — mock spawn, verify correct CLI args and env, verify parser is called with stdout, verify task state transitions; (2) runExecution — verify timeout handling, verify git polling starts/stops, verify abort/stop signal propagation; (3) runPlanning — verify read-only tool restrictions; (4) error paths — process crash, timeout, invalid output. Use Vitest with child_process mocking.

Commit: `187a4b0`

### 2026-03-07 — Audit and pin ansi-to-html for XSS safety

CardModal uses dangerouslySetInnerHTML with output from ansi-to-html@0.7.2. While cb05c88 added an escapeHtml fallback, the primary path trusts ansi-to-html to produce safe HTML from agent stdout which may contain user-controlled content. Actions: (1) Check ansi-to-html changelog for XSS-related fixes after 0.7.2; (2) Add a sanitization pass (e.g., DOMPurify or a simple tag whitelist allowing only <span> with style) between ansi-to-html output and innerHTML insertion; (3) Add a test case that verifies script tags in log input are escaped in rendered output.

Commit: `58e270a`

### 2026-03-07 — Skill editor with live preview and community sharing

Build an in-app skill editor that lets users create, edit, and test prompt templates (skills) without touching markdown files. Include: (1) Monaco/CodeMirror editor with markdown preview, (2) variable interpolation preview showing how the prompt looks with real project context injected, (3) a 'dry run' mode that shows the full prompt that would be sent to the agent without actually running it, (4) import/export skills as JSON bundles, (5) a curated skill library (local directory of community-contributed skills that ship with the project).

Commit: `2985d13`

### 2026-03-07 — Add request validation to API routes

Route handlers in server/routes/tasks.js and projects.js accept req.params.id and req.body fields without format validation. Add a lightweight validation layer: (1) Validate :id params are valid UUIDs before DB lookup; (2) Add max-length constraints to string fields (title: 200, description: 5000); (3) Validate enum fields beyond just 'effort' (e.g., status transitions). Use a simple validate() helper — no need for a heavy library since the API surface is small. Return 400 with descriptive messages.

Commit: `8eca093`

### 2026-03-07 — Fix race condition in project execution locking

In server/agents/runner.js, the project lock check (isProjectLocked) and lock acquisition are not atomic. Two concurrent requests can both see the project as unlocked, then both proceed. Replace the current boolean check-then-set pattern with an atomic lock function in state.js that returns true only if the lock was successfully acquired (compare-and-swap semantics). Example: acquireProjectLock(projectId) returns true if it was unlocked and is now locked, false if already locked.

Commit: `3c1cef5`

### 2026-03-07 — Use batch APIs for bulk board actions

In src/App.jsx, replace per-task sequential loops in handleBulkPlan and handleBulkDismiss with api.batchAction calls, then rely on websocket updates for final task state hydration. Add simple in-flight guards to prevent duplicate submissions while a batch request is active.

Commit: `767e539`

### 2026-03-07 — Make state persistence crash-safe

Refactor server/state.js persistence to use atomic writes (write temp file, fsync, rename) and keep a last-known-good backup state file. On startup parse failures, log the corruption explicitly and attempt recovery from backup instead of silently starting empty. Add persistence tests for partial-write and corrupt-primary recovery scenarios.

Commit: `91f8a40`

### 2026-03-07 — Harden outbound network guardrails

Create a shared outbound URL validator module (for example server/netguard.js) and apply it to server/index.js proxy requests plus server/notifications.js webhook/slack/discord sends. Enforce DNS resolution checks against private/reserved ranges, add redirect-depth limits for proxying, and remove rejectUnauthorized=false so TLS cert verification is on by default (with an explicit opt-in env override if needed).

Commit: `757a631`

### 2026-03-07 — Interactive analytics dashboard with cost and throughput trends

Add a dedicated dashboard view (toggle from the kanban board) showing: (1) cost over time per project and per model as line charts, (2) task throughput (proposed→done conversion rate, average time per phase), (3) success/failure rate by model, (4) token usage breakdown (input vs output), (5) autoclicker efficiency metrics (actions per cycle, cost per successful task). Use a lightweight chart library (e.g., recharts or uplot). Persist historical snapshots in state.json or a separate analytics.json file so trends survive restarts.

Commit: `b92ace1`

### 2026-03-07 — Smart task deduplication and conflict detection

Before adding newly generated tasks, run a similarity check against existing tasks (using TF-IDF or embedding-based comparison via a local model). Flag potential duplicates with a confidence score and let the user merge, skip, or keep both. During execution, detect when two tasks modify the same files and warn about potential merge conflicts. Add a 'related tasks' section in the CardModal showing semantically similar tasks across all statuses.

Commit: `22c8fc6`

### 2026-03-07 — GitHub PR workflow integration

After a task executes successfully (and passes tests if test-gating is enabled), automatically create a GitHub pull request using the `gh` CLI. Include the task title as PR title, the plan + rationale as PR body, and link back to the kanban task. Add PR status tracking: poll or webhook for CI status and review state. Show PR URL, CI status, and merge state on the task card. Add a 'Merge' button that merges the PR and updates the task. Support configurable PR templates per project and auto-assignment of reviewers.

Commit: `a8e4c05`

### 2026-03-07 — Add task dependency graph and execution ordering

Implement a dependency system where tasks can declare blockers (other task IDs that must complete first). Add a visual dependency graph in the UI (lightweight DAG renderer) and modify the execution queue to respect dependency ordering. The autoclicker judgment agent should also factor in unblocked vs blocked tasks when choosing what to act on next. Store dependencies as an array of task IDs on each task object. Add a 'blocked' badge on cards whose dependencies haven't completed.

Commit: `44959af`

### 2026-03-07 — Test-gated execution with automatic rollback

After an execution agent completes, automatically run the project's test suite. If tests fail, revert the agent's git commits (git revert or reset the branch), mark the task as 'failed' (new status), and store the test output in the task metadata. Add a 'failed' column to the kanban board. Failed tasks can be retried with a new planning pass that includes the failure context. Update the autoclicker to never re-execute a task that has failed more than N times without human review.

Commit: `1e960f2`

### 2026-03-07 — Implement Custom Theme-Aware Scrollbars

Replace the default OS/browser scrollbars in the columns, sidebar, and modals with custom, slim scrollbars using `::-webkit-scrollbar`. They should be styled with semi-transparent thumbs that match the dark/light themes and expand slightly on hover.

Commit: `7648b2d`

### 2026-03-07 — Lock server exposure by default

Change server startup in server/index.js to bind to HOST=127.0.0.1 by default instead of all interfaces, and add optional token auth middleware for mutating API routes when APP_API_TOKEN is configured. Document HOST and APP_API_TOKEN in .env.example and README so remote exposure is an explicit choice.

Commit: `3424e5b`

### 2026-03-07 — Normalize process handle lifecycle

Standardize process tracking in server/state.js and server/agents/runner.js so every tracked process uses a consistent shape { proc, stopPolling?, phase }. Then update server/routes/tasks.js abort/dismiss/stop-all paths to safely terminate via handle.proc and invoke stopPolling when present. Include regression tests for dismissing tasks in planning and executing states to prevent runtime type errors.

Commit: `81c6fdd`

### 2026-03-07 — Fix queue position event correctness

Adjust server/state.js enqueueTask to return the inserted task position (insertIdx + 1) instead of queue length, and ensure all queue broadcasts use that exact position. Add tests around priority insertion by sortOrder so queued UI position is accurate immediately after execution:queued events.

Commit: `be6ff5b`

### 2026-03-07 — Sanitize streamed log rendering

Update src/components/CardModal.jsx so ANSI conversion always escapes HTML before rendering: initialize AnsiToHtml with escapeXML=true, remove any raw-text fallback passed to dangerouslySetInnerHTML, and route log rendering through a helper that guarantees escaped output. Add a focused Vitest case for malicious log content such as <img onerror=...> to verify it is rendered as text, not executable HTML.

Commit: `cb05c88`
