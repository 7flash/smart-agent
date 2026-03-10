# Changelog

## [2.0.0] — 2026-03-10

### ⚡ Breaking
- Skill format changed from YAML to `.md` with YAML frontmatter (jsx-ai unified format)
- Removed scheduler and db from core package (use separate persistence)
- `SkillCommand` export removed (was never implemented)

### 🚀 Features
- **Parallel tool execution** — Read-only tools (`read_file`, `list_dir`, `search`) run concurrently via `Promise.all`. Write tools stay sequential.
- **Tool result streaming** — `onToolOutput` callback in `AgentConfig` enables real-time exec tool stdout/stderr streaming via `ReadableStream.getReader()`. New `tool_output_delta` event type.
- **Safe mode** — Interactive approval callback for controlling tool execution. Agent pauses and asks for confirmation before running potentially destructive operations.
- **Session confirmation gates** — Objective-level confirmation checkpoints in multi-turn sessions.
- **Memory skill** — Built-in skill for agent state persistence across sessions.
- **ARC puzzle solver** — Three-mode routing (conversational/arc/task), batch runner with retry for near-miss puzzles, deadline pressure + force-submit strategy.
- **LLM streaming** — Streaming support for all providers (Gemini, Claude, DeepSeek, OpenAI) with `thinking_delta` events.
- **Exponential backoff** — Automatic retry with exponential backoff for streaming failures.

### 🔧 Improvements
- GitHub Actions CI — `bun test` + `tsc --noEmit` on push/PR
- Exec timeout improved — captures partial output, includes command name in error
- Upgraded `jsx-ai` to `0.1.5` (zero tsc errors)
- Upgraded `measure-fn` to `^3.10.2`
- `cleanCode()` DRY helper for stripping markdown fences and function wrappers

### 🐛 Fixes
- Fixed broken Skill exports
- Null-safe metrics access in ARC batch aggregation
- Robust grid parser + auto-detect code in `submit_answer`
- README unclosed code block fixed

## [1.0.0] — 2025-12-01

### Initial Release
- `Agent` class — single-shot agentic loop with tools + objectives
- `Session` class — multi-turn planner-executor pipeline
- 6 built-in tools: `read_file`, `write_file`, `edit_file`, `exec`, `list_dir`, `search`
- Skills system (YAML-based)
- Objective hydration + validation
- Published as `smart-agent-ai` on npm
