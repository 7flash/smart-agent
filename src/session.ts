// smart-agent/src/session.ts
// Multi-turn chat session — planner adjusts objectives per message, executor runs them
// Features:
//   - Fast conversational routing (skips planner for obvious questions/comments)
//   - ARC-AGI puzzle integration (auto-detects puzzle requests)
//   - Confirmation gate for destructive operations
import { measure, measureSync } from "measure-fn"
import type {
    AgentConfig,
    AgentEvent,
    Message,
    PlannedObjective,
} from "./types"
import { Agent } from "./agent"
import { callText } from "jsx-ai"
import { hydrateObjective, PLANNER_SYSTEM_PROMPT } from "./objectives"
import { extractPuzzleId, fetchPuzzle, createArcTools, createArcObjective, ARC_SYSTEM_PROMPT, ARC_URGENCY_MESSAGE } from "./arc"

/** Session event — extends AgentEvent with session-level events */
export type SessionEvent =
    | AgentEvent
    | { type: "session_start"; sessionId: string }
    | { type: "replanning"; message: string }
    | { type: "awaiting_confirmation"; objectives: PlannedObjective[] }

/**
 * Classify a user message for routing purposes.
 * Returns:
 *   - 'conversational'  → skip the planner entirely, just respond
 *   - 'arc'             → ARC puzzle mode, inject puzzle tools
 *   - 'task'            → full planner pipeline
 */
function classifyMessage(message: string, hasHistory: boolean): 'conversational' | 'arc' | 'task' {
    const lower = message.toLowerCase().trim()

    // ── ARC puzzle detection ──
    if (/\b(arc|arc-agi|abstract reasoning)\b/i.test(lower) &&
        /\b(solve|try|attempt|run|challenge|puzzle)\b/i.test(lower)) {
        return 'arc'
    }
    // Bare puzzle ID (8 hex chars) with solve-like context
    if (/\b[0-9a-f]{8}\b/i.test(lower) && /\b(solve|puzzle|arc)\b/i.test(lower)) {
        return 'arc'
    }

    // ── Task detection — explicit action verbs targeting the system ──
    const taskPatterns = [
        /\b(create|make|write|build|generate|add|delete|remove|install|update|modify|edit|fix|deploy|setup|configure)\b.*\b(file|folder|directory|script|code|project|app|server|database|component|function|test|page)\b/i,
        /\b(run|execute|start|stop|restart|kill)\b.*\b(command|script|server|process|test)\b/i,
        /\b(save|store|persist|schedule|send)\b/i,
        /\bcreate\b.*\.(txt|ts|js|json|md|yaml|yml|html|css)/i,
    ]
    if (taskPatterns.some(p => p.test(lower))) return 'task'

    // ── Conversational patterns — skip planner for these ──
    const conversationalPatterns = [
        /^(what|who|why|how|when|where|which|is|are|was|were|do|does|did|can|could|would|should|shall)\b/i,
        /^(tell|explain|describe|summarize|compare|define|clarify|elaborate)\b/i,
        /^(hey|hi|hello|thanks|thank|ok|okay|sure|yes|no|yeah|nah|cool|nice|great|awesome|lol|haha|wow|interesting)\b/i,
        /\?$/,  // ends with question mark
    ]
    if (conversationalPatterns.some(p => p.test(lower))) return 'conversational'

    // ── Short follow-ups are usually conversational ──
    if (hasHistory && lower.split(/\s+/).length <= 8) return 'conversational'

    // Default: use the planner
    return 'task'
}

/**
 * A multi-turn chat session. Each user message goes through a pipeline:
 * 
 * 1. **Classifier** checks if the message is conversational, ARC, or a task
 * 2. **Planner** (skipped for conversational) generates/adjusts objectives
 * 3. **Executor** runs Agent.run() with the current objectives
 * 4. Results are accumulated in the session history
 * 
 * ```ts
 * const session = new Session({ model: "gemini-2.5-flash" })
 * 
 * for await (const event of session.send("create a hello world project")) {
 *   console.log(event.type)
 * }
 * 
 * // Follow-up — fast-path, no planner needed
 * for await (const event of session.send("what did you just create?")) {
 *   console.log(event.type)
 * }
 * ```
 */
export class Session {
    readonly id: string
    private config: AgentConfig
    private history: Message[] = []
    private plannerHistory: Array<{ role: string; content: string }> = []
    private completedObjectives: PlannedObjective[] = []
    private pendingObjectives: PlannedObjective[] = []
    private turnCount = 0
    private abortController: AbortController | null = null
    readonly requireConfirmation: boolean

    // Confirmation gate — resolves when user confirms or rejects
    private confirmationResolve: ((confirmed: boolean) => void) | null = null

    constructor(config: AgentConfig & { requireConfirmation?: boolean }) {
        this.id = randomId()
        this.config = config
        this.requireConfirmation = config.requireConfirmation ?? true

        // Initialize planner with system prompt
        this.plannerHistory = [
            { role: "system", content: PLANNER_SYSTEM_PROMPT + REFINEMENT_ADDENDUM },
        ]
    }

    /**
     * Send a message to the session. Routes through classifier → planner → executor.
     */
    async *send(message: string): AsyncGenerator<SessionEvent> {
        this.turnCount++
        const turn = this.turnCount

        // Track in user message history
        this.history.push({ role: "user", content: message })

        // ── Route based on message classification ──
        const msgType = classifyMessage(message, this.history.length > 1)

        if (msgType === 'conversational') {
            yield* this.handleConversational(message, turn)
        } else if (msgType === 'arc') {
            yield* this.handleArc(message, turn)
        } else {
            yield* this.handleTask(message, turn)
        }
    }

    // ══════════════════════════════════════
    // CONVERSATIONAL — fast path, no planner
    // ══════════════════════════════════════

    private async *handleConversational(message: string, turn: number): AsyncGenerator<SessionEvent> {
        const respondObjective: PlannedObjective = {
            name: `respond_${turn}`,
            description: `Respond to: "${message}"`,
            type: "respond",
            params: { topic: message }
        }

        this.pendingObjectives = [respondObjective]

        // Emit lightweight planning event — UI will show minimal ceremony
        yield { type: "planning", objectives: [{ ...respondObjective, _quick: true } as any] }

        // Run executor directly (no confirmation needed for conversational)
        const cwd = this.config.cwd ?? process.cwd()
        const objectives = [hydrateObjective(respondObjective, cwd)]

        const agent = new Agent({
            ...this.config,
            objectives,
        })

        const executorInput: Message[] = this.history.map(m => ({
            role: m.role,
            content: m.content,
        }))

        this.abortController = new AbortController()

        for await (const event of agent.run(executorInput, this.abortController.signal)) {
            yield event

            if (event.type === "complete") {
                this.completedObjectives.push(respondObjective)
                this.pendingObjectives = []
                this.history.push({
                    role: "assistant",
                    content: `Responded to: "${message}"`,
                })
            }
        }
    }

    // ══════════════════════════════════════
    // ARC — puzzle solving mode
    // ══════════════════════════════════════

    private async *handleArc(message: string, turn: number): AsyncGenerator<SessionEvent> {
        yield { type: "replanning", message }

        // Extract puzzle ID from message
        const puzzleId = extractPuzzleId(message)
        if (!puzzleId) {
            yield { type: "error", iteration: -1, error: "Could not determine which ARC puzzle to solve. Provide a puzzle ID (e.g. 0d3d703e)." }
            return
        }

        // Fetch the puzzle
        let puzzle
        try {
            puzzle = await measure(`Fetch ARC puzzle ${puzzleId}`, () => fetchPuzzle(puzzleId))
        } catch (e: any) {
            yield { type: "error", iteration: -1, error: `Failed to fetch puzzle ${puzzleId}: ${e.message}` }
            return
        }
        if (!puzzle) {
            yield { type: "error", iteration: -1, error: `Puzzle ${puzzleId} not found` }
            return
        }

        // Create ARC tools and objective
        const arcTools = createArcTools(puzzle)
        const arcObjective = createArcObjective(puzzle)

        const planned: PlannedObjective = {
            name: "solve_puzzle",
            description: arcObjective.description,
            type: "custom_check",
            params: { puzzle_id: puzzleId }
        }
        this.pendingObjectives = [planned]

        yield { type: "planning", objectives: [planned] }

        // No confirmation for ARC — it's read-only (no side effects)
        const agent = new Agent({
            ...this.config,
            objectives: [arcObjective],
            tools: arcTools,
            maxIterations: 10,
            temperature: 0.2,
            systemPrompt: ARC_SYSTEM_PROMPT,
        })

        this.abortController = new AbortController()

        let hasSubmitted = false
        let bestTransformCode: string | null = null
        let lastRunTransformCode: string | null = null

        for await (const event of agent.run(`Solve ARC puzzle ${puzzleId}`, this.abortController.signal)) {
            yield event

            // Track run_transform code from tool_start (which has params)
            if (event.type === "tool_start") {
                const ev = event as any
                if (ev.tool === "run_transform" && ev.params?.code) {
                    lastRunTransformCode = ev.params.code as string
                }
            }

            // Track submissions and successful transforms from tool_result
            if (event.type === "tool_result") {
                const ev = event as any
                if (ev.tool === "submit_answer" && ev.result?.success) hasSubmitted = true
                if (ev.tool === "run_transform" && ev.result?.success && lastRunTransformCode) {
                    bestTransformCode = lastRunTransformCode
                }
            }

            // Inject urgency on turn 7+ if not yet submitted
            if (event.type === "iteration_start") {
                const iter = (event as any).iteration ?? 0
                if (iter >= 7 && !hasSubmitted) {
                    // The agent will see this in its next tool result feedback
                    agent.injectMessage(ARC_URGENCY_MESSAGE)
                }
            }

            if (event.type === "complete") {
                this.completedObjectives.push(planned)
                this.pendingObjectives = []
                this.history.push({
                    role: "assistant",
                    content: `Solved ARC puzzle ${puzzleId}`,
                })
            }

            // On max_iterations, force-submit if agent never did
            if (event.type === "max_iterations" && !hasSubmitted && bestTransformCode) {
                const submitTool = arcTools.find(t => t.name === "submit_answer")
                if (submitTool) {
                    const result = await submitTool.execute({ grid: bestTransformCode, code: true })
                    yield { type: "tool_start", iteration: -1, tool: "submit_answer", params: { grid: "(forced)", code: true } }
                    yield { type: "tool_result", iteration: -1, tool: "submit_answer", result }
                }
            }
        }
    }

    // ══════════════════════════════════════
    // TASK — full planner pipeline
    // ══════════════════════════════════════

    private async *handleTask(message: string, turn: number): AsyncGenerator<SessionEvent> {
        // ── Stage 1: Planner — generate NEW objectives only ──
        yield { type: "replanning", message }

        // Tell the planner what's already done (immutable) and what's still pending
        let plannerUserMsg: string
        if (this.completedObjectives.length > 0 || this.pendingObjectives.length > 0) {
            const parts: string[] = []
            if (this.completedObjectives.length > 0) {
                parts.push(`COMPLETED (do NOT re-create or modify these):\n${JSON.stringify(this.completedObjectives, null, 2)}`)
            }
            if (this.pendingObjectives.length > 0) {
                parts.push(`STILL PENDING:\n${JSON.stringify(this.pendingObjectives, null, 2)}`)
            }
            parts.push(`New user message: "${message}"`)
            parts.push(`Generate ONLY new objectives for this message. Do NOT include any completed objectives.`)
            plannerUserMsg = parts.join('\n\n')
        } else {
            plannerUserMsg = message
        }

        this.plannerHistory.push({ role: "user", content: plannerUserMsg })

        const plannerResponse = await measure(`Planner (turn ${turn})`, () =>
            callText(this.config.model, this.plannerHistory, {
                temperature: this.config.temperature ?? 0.3,
                maxTokens: this.config.maxTokens ?? 4000,
            })
        )

        // Parse objectives
        const newObjectives = measureSync(`Parse objectives (turn ${turn})`, () => {
            let json = (plannerResponse || "").trim()
            if (json.startsWith("```")) {
                json = json.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
            }
            const parsed: PlannedObjective[] = JSON.parse(json)
            if (!Array.isArray(parsed) || parsed.length === 0) {
                throw new Error("Empty objectives")
            }
            return parsed
        })

        if (!newObjectives) {
            yield {
                type: "error",
                iteration: -1,
                error: `Planner failed to parse objectives.\nRaw: ${(plannerResponse || "").substring(0, 300)}`,
            }
            return
        }

        // Store planner response in history for future refinement
        this.plannerHistory.push({ role: "assistant", content: plannerResponse || "" })

        // The planned list for THIS turn = only the new objectives
        // (completed objectives stay in completedObjectives and are not re-run)
        this.pendingObjectives = newObjectives

        // Emit planning event — show ALL objectives (completed + new) for context
        const allObjectives = [
            ...this.completedObjectives.map(o => ({ ...o, completed: true })),
            ...newObjectives,
        ]
        yield { type: "planning", objectives: allObjectives }

        // ── Confirmation gate — pause and wait for user confirmation ──
        // Auto-confirm if all NEW objectives are pure "respond" type (no side effects)
        const isConversational = newObjectives.every(p => p.type === "respond")

        if (this.requireConfirmation && !isConversational) {
            yield { type: "awaiting_confirmation", objectives: allObjectives }

            const confirmed = await new Promise<boolean>(resolve => {
                this.confirmationResolve = resolve
            })

            if (!confirmed) {
                this.history.push({ role: "assistant", content: "Objectives rejected by user." })
                yield { type: "error", iteration: -1, error: "User rejected the proposed objectives." }
                return
            }
        }

        // ── Stage 2: Executor — run with ONLY new objectives ──
        const cwd = this.config.cwd ?? process.cwd()
        const objectives = measureSync(`Hydrate objectives (turn ${turn})`, () =>
            newObjectives.map(p => hydrateObjective(p, cwd))
        )!

        const agent = new Agent({
            ...this.config,
            objectives,
        })

        // Pass full conversation history to executor
        const executorInput: Message[] = this.history.map(m => ({
            role: m.role,
            content: m.content,
        }))

        // Reset abort controller for this turn
        this.abortController = new AbortController()

        for await (const event of agent.run(executorInput, this.abortController.signal)) {
            yield event

            // Track completion — move new objectives to completed
            if (event.type === "complete") {
                this.completedObjectives.push(...newObjectives)
                this.pendingObjectives = []
                this.history.push({
                    role: "assistant",
                    content: `Completed objectives: ${newObjectives.map(p => p.name).join(", ")}`,
                })
            }
        }
    }

    // ══════════════════════════════════════
    // PUBLIC API
    // ══════════════════════════════════════

    /** Confirm objectives and proceed with execution */
    confirmObjectives() {
        if (this.confirmationResolve) {
            this.confirmationResolve(true)
            this.confirmationResolve = null
        }
    }

    /** Reject objectives — stops execution for this turn */
    rejectObjectives() {
        if (this.confirmationResolve) {
            this.confirmationResolve(false)
            this.confirmationResolve = null
        }
    }

    /** Whether the session is waiting for user confirmation */
    get isAwaitingConfirmation(): boolean {
        return this.confirmationResolve !== null
    }

    /** Abort the currently running agent loop */
    abort() {
        if (this.abortController) {
            this.abortController.abort()
            this.abortController = null
        }
        // Also reject any pending confirmation
        this.rejectObjectives()
    }

    /** Get the current session history */
    getHistory(): readonly Message[] {
        return this.history
    }

    /** Get current planned objectives (completed + pending) */
    getObjectives(): readonly PlannedObjective[] {
        return [...this.completedObjectives, ...this.pendingObjectives]
    }
}

function randomId(): string {
    return Math.random().toString(36).substring(2, 10)
}

/** Addendum to planner system prompt for refinement mode */
const REFINEMENT_ADDENDUM = `

REFINEMENT MODE:
When you receive context with COMPLETED and/or PENDING objectives along with a new user message:
1. NEVER re-create or modify completed objectives — they are done and immutable
2. Generate ONLY new objectives that address the NEW user message
3. If the user is asking a follow-up question or conversational request, use type "respond"
4. Only create tool-based objectives if the user explicitly asks for new actions
5. Do NOT repeat objectives that already exist in COMPLETED or PENDING

Respond with ONLY the new objectives as a JSON array. Do NOT include completed objectives.`
