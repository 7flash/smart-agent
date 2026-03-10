// smart-agent/src/index.ts
export { Agent } from "./agent"
export { Session } from "./session"
export type { SessionEvent } from "./session"
export { hydrateObjective } from "./objectives"
export { fetchPuzzle, fetchPuzzleIndex, createArcTools, createArcObjective, extractPuzzleId, gridToText, gridsEqual, parseGrid, ARC_URGENCY_MESSAGE } from "./arc"
export type { ArcPuzzle } from "./arc"
export { callText, streamLLM } from "jsx-ai"
export { loadSkills, formatSkillsForPrompt } from "./skills"
export type { Skill } from "./skills"
export { ToolError, ToolTimeoutError, ToolPermissionError, ToolNotFoundError, ToolValidationError, classifyError } from "./errors"
export type { ToolErrorCode } from "./errors"
export type {
    AgentConfig,
    AgentEvent,
    AgentState,
    Message,
    Objective,
    ObjectiveResult,
    PlannedObjective,
    Tool,
    ToolResult,
} from "./types"

