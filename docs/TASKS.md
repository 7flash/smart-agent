# Smart Agent — Tasks & Ideas

## 🟡 Priority: Improve
- [x] ~~**Tool execution timeout handling**~~ — ✅ DONE. Timeout now captures partial stdout/stderr before killing, includes command name and human-friendly duration in error message, suggests mitigation.
- [x] ~~**Safe mode UX**~~ — ✅ DONE. Added `onApproval` callback to `AgentConfig`. When safeMode is ON, exec tool calls `onApproval(tool, params)` to let the user approve/reject interactively. Without the callback, falls back to blocking error. New `approval_required` event type.

## 🟢 Priority: Features
- [x] ~~**Parallel tool execution**~~ — ✅ DONE. Read-only tools (read_file, list_dir, search) now run concurrently via `Promise.all`. Write tools stay sequential.
- [x] ~~**Tool result streaming**~~ — ✅ DONE. Added `onToolOutput` callback to `AgentConfig`. When provided, exec tool streams stdout/stderr chunks in real-time via `ReadableStream.getReader()`. New `tool_output_delta` event type.
- [x] ~~**GitHub Actions CI**~~ — ✅ DONE. `ci.yml` runs `bun test` and `tsc --noEmit` on push/PR to main.
- [x] ~~**Integration test suite**~~ — ✅ DONE. `src/integration.test.ts` with 6 tests: Agent.run() file creation, error handling, Agent.plan() dynamic objectives, multi-turn conversation history, abort signal, tool call parsing. All gated behind API keys. Total: 50 tests, 80 expect() calls.
- [x] ~~**npm publish + versioning**~~ — ✅ DONE. Published `smart-agent-ai@2.0.0` to npm. CHANGELOG.md created with 3 breaking changes, 8 features, 4 improvements, 4 fixes documented. Description and keywords updated.

## 📝 Architecture Notes
- **Package**: `smart-agent-ai` on npm (v2.1.0)
- **Tests**: 50 passing (80 expect() calls) — `bun test`
- **Core**: `Agent` (single-shot loop), `Session` (multi-turn with planner)
- **Tools**: 6 built-in (read/write/edit/exec/list/search) + custom tool support
- **LLM**: Via jsx-ai (Gemini, Claude, DeepSeek, OpenAI)
- **Skills**: .md files with YAML frontmatter injected into system prompt
- **DB**: SQLite for sessions/memory (`smart-agent.db`)

## ✅ Completed
- [x] ~~**README code block fix**~~ — Fixed unclosed code fence in Custom Tools section.
