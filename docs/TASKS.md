# Smart Agent — Tasks & Ideas

## 🟡 Priority: Improve
- [ ] **Tool execution timeout handling** — Currently `exec` timeout kills the process but doesn't clearly communicate the timeout reason back to the LLM. Could add explicit "Command timed out after 30s" messaging.
- [ ] **Safe mode UX** — When `safeMode: true`, the agent is told to "ask the user" but there's no actual interactive prompt mechanism. Could add a callback or event.

## 🟢 Priority: Features
- [ ] **Parallel tool execution** — Currently tools execute sequentially. When the LLM requests multiple independent tool calls, they could run in parallel.
- [ ] **Tool result streaming** — Stream large `exec` outputs to the LLM incrementally instead of waiting for the full result.
- [ ] **GitHub Actions CI** — Add a workflow that runs `bun test` on PR.

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
