# Smart Agent — Tasks & Ideas

## 🟡 Priority: Improve
- [x] ~~**Tool execution timeout handling**~~ — ✅ DONE. Timeout now captures partial stdout/stderr before killing, includes command name and human-friendly duration in error message, suggests mitigation.
- [ ] **Safe mode UX** — When `safeMode: true`, the agent is told to "ask the user" but there's no actual interactive prompt mechanism. Could add a callback or event.

## 🟢 Priority: Features
- [x] ~~**Parallel tool execution**~~ — ✅ DONE. Read-only tools (read_file, list_dir, search) now run concurrently via `Promise.all`. Write tools stay sequential.
- [ ] **Tool result streaming** — Stream large `exec` outputs to the LLM incrementally instead of waiting for the full result.
- [x] ~~**GitHub Actions CI**~~ — ✅ DONE. `ci.yml` runs `bun test` and `tsc --noEmit` on push/PR to main.

## 📝 Architecture Notes
- **Package**: `smart-agent-ai` on npm (v1.0.0)
- **Tests**: 44 passing (80 expect() calls) — `bun test`
- **Core**: `Agent` (single-shot loop), `Session` (multi-turn with planner)
- **Tools**: 6 built-in (read/write/edit/exec/list/search) + custom tool support
- **LLM**: Via jsx-ai (Gemini, Claude, DeepSeek, OpenAI)
- **Skills**: .md files with YAML frontmatter injected into system prompt
- **DB**: SQLite for sessions/memory (`smart-agent.db`)

## ✅ Completed
- [x] ~~**README code block fix**~~ — Fixed unclosed code fence in Custom Tools section.
