// smart-agent/src/objectives.ts
// Built-in objective templates — the planner generates these as data, we hydrate them into real Objective objects
import type { Objective, PlannedObjective } from "./types"

/**
 * Hydrate a PlannedObjective (data) into a real Objective (with validate function).
 * The planner agent outputs PlannedObjective[] as structured data, and we convert them here.
 */
export function hydrateObjective(planned: PlannedObjective, cwd: string): Objective {
  switch (planned.type) {
    case "file_exists":
      return {
        name: planned.name,
        description: planned.description,
        validate: async () => {
          const path = resolvePath(cwd, planned.params.path!)
          const file = Bun.file(path)
          if (!(await file.exists())) return { met: false, reason: `File not found: ${planned.params.path}` }
          // Optionally check content substring
          if (planned.params.contains) {
            const content = await file.text()
            if (!content.includes(planned.params.contains)) {
              return { met: false, reason: `File exists but missing: "${planned.params.contains}"` }
            }
          }
          return { met: true, reason: `File exists: ${planned.params.path}` }
        },
      }

    case "file_contains":
      return {
        name: planned.name,
        description: planned.description,
        validate: async () => {
          const path = resolvePath(cwd, planned.params.path!)
          const file = Bun.file(path)
          if (!(await file.exists())) return { met: false, reason: `File not found: ${planned.params.path}` }
          const content = await file.text()
          if (!content.includes(planned.params.text!)) {
            return { met: false, reason: `File missing content: "${planned.params.text}"` }
          }
          return { met: true, reason: `File contains required content` }
        },
      }

    case "command_succeeds":
      return {
        name: planned.name,
        description: planned.description,
        validate: (state) => {
          const cmd = planned.params.command!
          const keywords = cmd.split(/\s+/).filter(w => w.length > 1)
          const match = state.toolHistory.findLast(
            t => t.tool === "exec" && keywords.some(kw => t.params.command?.includes(kw))
          )
          if (!match) return { met: false, reason: `Command "${cmd}" not executed yet` }
          return {
            met: match.result.success,
            reason: match.result.success ? `Command succeeded` : `Command failed: ${match.result.error}`,
          }
        },
      }

    case "command_output_contains":
      return {
        name: planned.name,
        description: planned.description,
        validate: (state) => {
          const cmd = planned.params.command!
          const text = planned.params.text!
          const keywords = cmd.split(/\s+/).filter(w => w.length > 1)
          const match = state.toolHistory.findLast(
            t => t.tool === "exec" && keywords.some(kw => t.params.command?.includes(kw))
          )
          if (!match) return { met: false, reason: `Command "${cmd}" not executed yet` }
          if (!match.result.output.includes(text)) {
            return { met: false, reason: `Output missing: "${text}"` }
          }
          return { met: true, reason: `Output contains "${text}"` }
        },
      }

    case "custom_check":
      // Custom check — the description tells the LLM what to verify
      // Check if any successful tool execution happened across the session
      return {
        name: planned.name,
        description: planned.description,
        validate: (state) => {
          const hasSuccess = state.toolHistory.some(t => t.result.success)
          return {
            met: hasSuccess,
            reason: hasSuccess ? "Tool execution succeeded" : "No successful tool execution yet",
          }
        },
      }

    case "respond":
      // Conversational response — automatically met once the LLM produces a thinking message
      return {
        name: planned.name,
        description: planned.description,
        validate: (state) => {
          // Met after the first iteration (LLM has had a chance to respond)
          return {
            met: state.iteration >= 0,
            reason: state.iteration >= 0 ? "Response delivered" : "Waiting for response",
          }
        },
      }

    case "task_scheduled":
      // Check if a schedule task was created via the schedule tool
      return {
        name: planned.name,
        description: planned.description,
        validate: (state) => {
          const match = state.toolHistory.findLast(
            t => t.tool === "schedule" && t.params.action === "create" && t.result.success
          )
          return match
            ? { met: true, reason: `Task scheduled: ${match.result.output.substring(0, 100)}` }
            : { met: false, reason: "No task scheduled yet. Use the schedule tool with action='create'." }
        },
      }

    default:
      throw new Error(`Unknown objective type: ${(planned as any).type}`)
  }
}

function resolvePath(cwd: string, filePath: string): string {
  if (filePath.startsWith("/") || /^[A-Za-z]:[/\\]/.test(filePath)) return filePath
  const sep = cwd.includes("\\") ? "\\" : "/"
  return `${cwd}${sep}${filePath}`
}

/** The system prompt the planner agent uses to generate objectives */
export const PLANNER_SYSTEM_PROMPT = `You are a planning agent. Your job is to analyze a user request and generate specific, verifiable objectives.

For each objective, choose one of these types:
- respond: For conversational requests (questions, jokes, explanations, advice) that DON'T need tools
  params: { topic: "brief description of what to respond about" }
- file_exists: Check that a file exists (optionally with specific content)
  params: { path: "file/path", contains?: "optional content to check" }
- file_contains: Check that a file contains specific text
  params: { path: "file/path", text: "required text" }
- command_succeeds: Check that a command exits with code 0
  params: { command: "the command to check" }
- command_output_contains: Check that a command's output contains text
  params: { command: "the command", text: "expected output" }
- custom_check: Generic check (least preferred — use specific types when possible)
  params: { check: "description of what to verify" }
- task_scheduled: Check that a scheduled task has been created using the schedule tool
  params: { name: "task name" }

IMPORTANT RULES:
1. Use "respond" for simple questions, knowledge requests, jokes, or explanations.
2. Use tool-based types only when the user wants something done on the system.
3. For scheduling/repeating tasks, ALWAYS create TWO objectives:
   a) file_exists — create a script at scripts/<name>.ts that does the actual work
   b) task_scheduled — schedule the script for execution via the schedule tool
4. ALL scheduled scripts MUST go in the scripts/ directory.
5. Scripts MUST use the EXACT template below. NEVER import from external packages.
   The getState/setState functions are defined inline — do NOT import them from anywhere.

MANDATORY SCRIPT TEMPLATE — copy this EXACTLY, only change the main() logic:

\`\`\`typescript
// scripts/<name>.ts — Description
// Env vars injected by scheduler: AGENT_ID, STATE_URL
const AGENT_ID = process.env.AGENT_ID!;
const STATE_URL = process.env.STATE_URL!; // http://127.0.0.1:3737/api/agent-state

// Read state: GET STATE_URL?agentId=X&key=Y → { value: "..." | null }
async function getState(key: string): Promise<string | null> {
  const res = await fetch(\\\`\\\${STATE_URL}?agentId=\\\${AGENT_ID}&key=\\\${encodeURIComponent(key)}\\\`);
  const data = await res.json();
  return data.value ?? null;
}

// Write state: POST STATE_URL { agentId, key, value }
async function setState(key: string, value: string): Promise<void> {
  await fetch(STATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: Number(AGENT_ID), key, value }),
  });
}

async function main() {
  // ... your logic here ...
  // Use getState/setState to persist data between runs
  // Print output to stdout — it will be captured and shown in chat
  console.log("output goes here");
}

main();
\`\`\`

Respond with a JSON array of objectives. Each objective has: name, description, type, params.

RESPOND WITH ONLY VALID JSON. No markdown, no explanation, just a JSON array.

Example responses:

For "tell me a joke":
[
  {
    "name": "tell_joke",
    "description": "Tell the user a funny joke",
    "type": "respond",
    "params": { "topic": "joke" }
  }
]

For "create a hello.txt file":
[
  {
    "name": "create_hello_file",
    "description": "Create hello.txt with Hello World content",
    "type": "file_exists",
    "params": { "path": "hello.txt", "contains": "Hello World" }
  }
]

For "tell me a joke every minute":
[
  {
    "name": "create_joke_script",
    "description": "Create scripts/joke-sender.ts following the SCRIPT TEMPLATE. Include 10+ jokes in an array. Use getState/setState to track used jokes so they never repeat. Output one random unused joke to stdout.",
    "type": "file_exists",
    "params": { "path": "scripts/joke-sender.ts", "contains": "getState" }
  },
  {
    "name": "schedule_joke_task",
    "description": "Schedule scripts/joke-sender.ts to run every 60 seconds using the schedule tool with scriptPath='scripts/joke-sender.ts'",
    "type": "task_scheduled",
    "params": { "name": "joke_sender" }
  }
]`



