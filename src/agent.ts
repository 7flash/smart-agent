// smart-agent/src/agent.ts
// Core agentic loop — iterates LLM + tools until all objectives pass
import { measure, measureSync } from "measure-fn"
import type {
    AgentConfig,
    AgentEvent,
    AgentState,
    Message,
    Objective,
    ObjectiveResult,
    PlannedObjective,
    Tool,
    ToolInvocation,
    ToolResult,
} from "./types"
import { createBuiltinTools } from "./tools"
import { loadSkills, formatSkillsForPrompt } from "./skills"
import { hydrateObjective, PLANNER_SYSTEM_PROMPT } from "./objectives"

// jsx-ai — strategy-agnostic LLM caller with provider auto-detection
import { callLLM as jsxCallLLM, callText, streamLLM } from "jsx-ai"
import { jsx, Fragment } from "jsx-ai/jsx-runtime"
import type { LLMResponse } from "jsx-ai"

export class Agent {
    private config: Required<Pick<AgentConfig, "model" | "maxIterations" | "temperature" | "maxTokens" | "cwd" | "toolTimeoutMs">> & AgentConfig
    private objectives: Objective[]
    private tools: Map<string, Tool>
    private skillsPrompt: string = ""
    private initialized = false

    constructor(config: AgentConfig) {
        this.objectives = config.objectives || []

        this.config = {
            ...config,
            maxIterations: config.maxIterations ?? 20,
            temperature: config.temperature ?? 0.3,
            maxTokens: config.maxTokens ?? 8000,
            cwd: config.cwd ?? process.cwd(),
            toolTimeoutMs: config.toolTimeoutMs ?? 30000,
        }

        // Register built-in tools + custom tools
        this.tools = new Map()
        for (const tool of createBuiltinTools(this.config.cwd, this.config.toolTimeoutMs)) {
            this.tools.set(tool.name, tool)
        }
        if (config.tools) {
            for (const tool of config.tools) {
                this.tools.set(tool.name, tool)
            }
        }
    }

    /** Lazily load skills (only once) */
    private async ensureInitialized(): Promise<void> {
        if (this.initialized) return
        this.initialized = true

        if (this.config.skills && this.config.skills.length > 0) {
            await measure('Load skills', async () => {
                const skills = await loadSkills(this.config.skills!)
                this.skillsPrompt = formatSkillsForPrompt(skills)
            })
        }
    }

    /**
     * Run the agentic loop with predefined objectives.
     * 
     * Accepts a simple string prompt OR a message array for conversation history:
     * ```ts
     * // Simple prompt
     * for await (const event of agent.run("fix the tests")) {}
     * 
     * // Conversation history
     * for await (const event of agent.run([
     *   { role: "user", content: "fix the auth tests" },
     *   { role: "assistant", content: "I'll look at the test files..." },
     *   { role: "user", content: "focus on login.test.ts" },
     * ])) {}
     * ```
     */
    async *run(input: string | Message[], signal?: AbortSignal): AsyncGenerator<AgentEvent> {
        if (this.objectives.length === 0) {
            throw new Error("No objectives defined. Use Agent.plan() for dynamic objective generation, or pass objectives in the constructor.")
        }

        await this.ensureInitialized()
        const startTime = Date.now()

        const state: AgentState = {
            messages: [],
            iteration: 0,
            toolHistory: [],
            touchedFiles: new Set(),
        }

        // System prompt as first message
        state.messages.push({
            role: "system",
            content: this.buildSystemPrompt(),
        })

        // User input — string or message array
        if (typeof input === "string") {
            state.messages.push({ role: "user", content: input })
        } else {
            // Append conversation history after system prompt
            for (const msg of input) {
                if (msg.role === "system") continue // skip — we already have our system prompt
                state.messages.push({ role: msg.role, content: msg.content })
            }
        }

        yield* this.executeLoop(state, startTime, signal)
    }

    /**
     * Plan + execute: dynamically generate objectives from a user prompt, then run.
     * 
     * Uses a planner LLM call to analyze the user's request and create
     * verifiable objectives, then executes the agent with those objectives.
     * 
     * ```ts
     * for await (const event of Agent.plan("make the auth tests pass", {
     *   model: "gemini-3-flash-preview",
     *   skills: ["./skills/bun.yaml"],
     * })) {
     *   console.log(event.type)
     * }
     * ```
     */
    static async *plan(input: string | Message[], config: AgentConfig): AsyncGenerator<AgentEvent> {
        const cwd = config.cwd ?? process.cwd()

        // Extract the user's actual prompt
        const userPrompt = typeof input === "string"
            ? input
            : input.filter(m => m.role === "user").map(m => m.content).join("\n")

        // ── Stage 1: Planner — generate objectives ──
        const plannerMessages: Array<{ role: string; content: string }> = [
            { role: "system", content: PLANNER_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
        ]

        const plannerResponse = await measure("Planner", () =>
            callText(config.model, plannerMessages, {
                temperature: config.temperature ?? 0.3,
                maxTokens: config.maxTokens ?? 4000,
            })
        )

        // Parse the planner's JSON response
        let planned: PlannedObjective[]
        try {
            // Strip markdown code fences if present
            let json = (plannerResponse || "").trim()
            if (json.startsWith("```")) {
                json = json.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
            }
            planned = JSON.parse(json)
            if (!Array.isArray(planned) || planned.length === 0) {
                throw new Error("Planner returned empty objectives")
            }
        } catch (e: any) {
            yield { type: "error", iteration: -1, error: `Planner failed to generate objectives: ${e.message}\nRaw: ${(plannerResponse || "").substring(0, 300)}` }
            return
        }

        // Hydrate planned objectives into real Objective objects
        const objectives = planned.map(p => hydrateObjective(p, cwd))

        // Emit planning event so consumers know what's being worked on
        yield { type: "planning", objectives: planned }

        // ── Stage 2: Worker — execute with generated objectives ──
        const agent = new Agent({
            ...config,
            objectives,
        })

        yield* agent.run(input)
    }

    // ── Core loop (shared by run + plan) ──

    private async *executeLoop(state: AgentState, startTime: number, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
        for (let i = 0; i < this.config.maxIterations; i++) {
            // Check abort before each iteration
            if (signal?.aborted) {
                yield { type: "cancelled", iteration: i, elapsed: Date.now() - startTime }
                return
            }

            state.iteration = i
            yield { type: "iteration_start", iteration: i, elapsed: Date.now() - startTime }

            try {
                // ── Stream LLM response — yield thinking_delta events in real-time ──
                let accumulated = ""
                let streamed = false
                let llmResult: LLMResponse | null = null

                try {
                    // Try streaming first for real-time UX
                    const messages = state.messages.map(m => ({
                        role: m.role as string,
                        content: m.content,
                    }))

                    for await (const chunk of streamLLM(this.config.model, messages, {
                        temperature: this.config.temperature,
                        maxTokens: this.config.maxTokens,
                    })) {
                        accumulated += chunk
                        yield { type: "thinking_delta", iteration: i, delta: chunk }
                        streamed = true
                    }
                } catch (streamErr: any) {
                    // Streaming failed — fall back to structured call
                    if (!streamed) {
                        llmResult = await measure(`LLM ${this.config.model}`, () =>
                            this.callWithJsxAi(state.messages)
                        ) as LLMResponse

                        if (!llmResult) {
                            yield { type: "error", iteration: i, error: "LLM returned empty response" }
                            state.messages.push({ role: "user", content: "Empty response. Try again." })
                            continue
                        }

                        accumulated = llmResult.text || ""
                    }
                }

                if (!accumulated && !llmResult) {
                    yield { type: "error", iteration: i, error: "LLM returned empty response" }
                    state.messages.push({ role: "user", content: "Empty response. Try again." })
                    continue
                }

                // If we streamed, parse tool calls from the accumulated text
                let invocations: ToolInvocation[]

                if (llmResult) {
                    // Structured path — tool calls from jsx-ai
                    invocations = llmResult.toolCalls.map(tc => ({
                        tool: tc.name,
                        params: tc.args,
                        reasoning: "",
                    }))
                } else {
                    // Streaming path — extract tool calls from text
                    invocations = this.parseToolCallsFromText(accumulated)
                    // Strip tool call JSON from the thinking text for display
                    const thinkingText = accumulated.replace(/```json[\s\S]*?```/g, "").trim()
                    if (thinkingText) {
                        accumulated = thinkingText
                    }
                }

                // Emit final thinking message (for non-streaming consumers)
                if (accumulated) {
                    yield { type: "thinking", iteration: i, message: accumulated }
                }

                // Store assistant message
                const assistantContent = accumulated ||
                    (invocations.length > 0
                        ? invocations.map(inv => `${inv.tool}(${JSON.stringify(inv.params)})`).join(", ")
                        : "(empty)")
                state.messages.push({ role: "assistant", content: assistantContent })

                // ── Execute tool calls ──
                if (invocations.length > 0) {
                    const toolMessages: string[] = []

                    for (const inv of invocations) {
                        const tool = this.tools.get(inv.tool)
                        if (!tool) {
                            const err = `Unknown tool: "${inv.tool}". Available: ${[...this.tools.keys()].join(", ")}`
                            toolMessages.push(`[${inv.tool}] ERROR: ${err}`)
                            yield { type: "tool_result", iteration: i, tool: inv.tool, result: { success: false, output: "", error: err } }
                            continue
                        }

                        yield { type: "tool_start", iteration: i, tool: inv.tool, params: inv.params }

                        const result = await measure(`Tool: ${inv.tool}`, () => tool.execute(inv.params)) as ToolResult

                        state.toolHistory.push({ iteration: i, tool: inv.tool, params: inv.params, result })

                        if (inv.params.path) {
                            state.touchedFiles.add(inv.params.path)
                        }

                        yield { type: "tool_result", iteration: i, tool: inv.tool, result }

                        const icon = result.success ? "✓" : "✗"
                        toolMessages.push(`[${inv.tool}] ${icon}\n${result.output}${result.error ? `\nERROR: ${result.error}` : ""}`)
                    }

                    state.messages.push({
                        role: "tool",
                        content: `Tool results:\n\n${toolMessages.join("\n\n")}`,
                    })
                }

                // ── Check objectives ──
                const objectiveResults = await measure('Check objectives', () => this.checkObjectives(state)) as Array<{ name: string; met: boolean; reason: string }>
                yield { type: "objective_check", iteration: i, results: objectiveResults as Array<{ name: string; met: boolean; reason: string }> }

                const allMet = objectiveResults.every(o => o.met)

                if (allMet) {
                    yield { type: "complete", iteration: i, elapsed: Date.now() - startTime }
                    return
                }

                // Not all met — add feedback for next iteration
                if (invocations.length === 0) {
                    const feedback = objectiveResults
                        .filter(o => !o.met)
                        .map(o => `- "${o.name}": NOT MET — ${o.reason}`)
                        .join("\n")

                    state.messages.push({
                        role: "user",
                        content: `The following objectives are NOT met yet. Use tools to make progress:\n${feedback}`,
                    })
                }

            } catch (error: any) {
                yield { type: "error", iteration: i, error: error.message || String(error) }
                state.messages.push({
                    role: "user",
                    content: `Error in iteration ${i}: ${error.message}. Recover and continue.`,
                })
            }
        }

        yield { type: "max_iterations", iteration: this.config.maxIterations }
    }

    /**
     * Parse tool calls from streamed LLM text.
     * Supports two formats:
     * 1. JSON tool calls in code fences: ```json [{"tool":"name","params":{...}}] ```
     * 2. XML-style tool calls: <tool_call name="exec"><param name="command">ls</param></tool_call>
     */
    private parseToolCallsFromText(text: string): ToolInvocation[] {
        const invocations: ToolInvocation[] = []

        // Pattern 1: JSON in code fences — [{"tool":"name","params":{...}}]
        const jsonFenceMatch = text.match(/```json\s*([\s\S]*?)```/)
        if (jsonFenceMatch) {
            try {
                const parsed = JSON.parse(jsonFenceMatch[1].trim())
                const arr = Array.isArray(parsed) ? parsed : [parsed]
                for (const item of arr) {
                    if (item.tool && item.params) {
                        invocations.push({
                            tool: item.tool,
                            params: item.params,
                            reasoning: item.reasoning || "",
                        })
                    }
                }
                if (invocations.length > 0) return invocations
            } catch { /* not valid JSON, continue */ }
        }

        // Pattern 2: Inline JSON objects — {"tool":"name","params":{...}}
        const inlineJsonRegex = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"params"\s*:\s*(\{[^}]*\})/g
        let match: RegExpExecArray | null
        while ((match = inlineJsonRegex.exec(text)) !== null) {
            try {
                const params = JSON.parse(match[2])
                invocations.push({ tool: match[1], params, reasoning: "" })
            } catch { continue }
        }

        return invocations
    }

    // ── jsx-ai integration ──

    /**
     * Build a JSX tree and call the LLM via jsx-ai.
     * jsx-ai picks the best strategy automatically (hybrid for Gemini).
     * The agent doesn't care whether tools are sent as XML, natural language, or native FC.
     */
    private async callWithJsxAi(messages: Message[]): Promise<LLMResponse> {
        const h = jsx

        // Build tool nodes from registered tools
        const toolNodes = [...this.tools.values()].map(t =>
            h("tool", {
                name: t.name,
                description: t.description,
                children: Object.entries(t.parameters).map(([name, p]) =>
                    h("param", {
                        name,
                        type: p.type,
                        required: p.required,
                        children: p.description,
                    })
                ),
            })
        )

        // Build message nodes from conversation history
        const messageNodes = messages.map(m => {
            if (m.role === "system") {
                return h("system", { children: m.content })
            }
            return h("message", {
                role: m.role === "tool" ? "user" : m.role as "user" | "assistant",
                children: m.content,
            })
        })

        // Assemble the prompt tree
        const tree = h("prompt", {
            model: this.config.model,
            temperature: this.config.temperature,
            maxTokens: this.config.maxTokens,
            children: [
                ...messageNodes,
                ...toolNodes,
            ],
        })

        return await jsxCallLLM(tree)
    }

    // ── Internal ──

    private buildSystemPrompt(): string {
        return measureSync('Build system prompt', () => this.buildSystemPromptInner())!
    }

    private buildSystemPromptInner(): string {
        const objectiveList = this.objectives
            .map((o, i) => `  ${i + 1}. [${o.name}] ${o.description}`)
            .join("\n")

        const custom = this.config.systemPrompt ? `\n\n${this.config.systemPrompt}` : ""

        // Check if all objectives are conversational (respond type)
        const isConversational = this.objectives.every(o =>
            o.name.includes('respond') || o.name.includes('tell') || o.name.includes('explain') || o.name.includes('joke') || o.name.includes('answer')
        )

        const conversationalHint = isConversational
            ? `\n\nNOTE: These objectives are conversational — just provide a helpful response. No tools needed.`
            : ""

        // Build tool descriptions for the system prompt
        const toolDescriptions = [...this.tools.values()].map(t => {
            const params = Object.entries(t.parameters)
                .map(([name, p]) => `    ${name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`)
                .join("\n")
            return `  ${t.name}: ${t.description}\n${params}`
        }).join("\n\n")

        return `You are an autonomous agent that works toward objectives using tools.
You operate in a loop: analyze state → invoke tools → repeat until all objectives are met.
${this.skillsPrompt}

OBJECTIVES (all must be met to complete):
${objectiveList}
${conversationalHint}
${custom}

AVAILABLE TOOLS:
${toolDescriptions}

TOOL CALL FORMAT:
When you need to use tools, output a JSON code block with your tool calls:
\`\`\`json
[{"tool": "tool_name", "params": {"param1": "value1"}}]
\`\`\`

You can invoke multiple tools in a single JSON array. First explain your thinking, then output the tool calls.

RULES:
1. Use available tools to make progress toward ALL objectives
2. You can invoke multiple tools per turn — put them all in one JSON array
3. Be precise with file paths and command syntax
4. Learn from tool errors — NEVER repeat the exact same failing tool call
5. If a tool fails twice, try an alternative approach or explain why it can't be done
6. When writing code, ensure it is correct and complete
7. Keep messages concise but informative
8. If the objective just asks for a response (explanation, joke, advice), just respond — no tools needed
9. On Windows, use PowerShell commands: 'Get-ChildItem' not 'ls', 'Get-Content' not 'cat'
10. If you cannot make progress, explain the blocker — do NOT repeat failed actions`
    }

    private async checkObjectives(state: AgentState): Promise<Array<{ name: string; met: boolean; reason: string }>> {
        const results: Array<{ name: string; met: boolean; reason: string }> = []

        for (const objective of this.objectives) {
            try {
                const result: ObjectiveResult = await objective.validate(state)
                results.push({ name: objective.name, met: result.met, reason: result.reason })
            } catch (e: any) {
                results.push({ name: objective.name, met: false, reason: `Validator error: ${e.message}` })
            }
        }

        return results
    }
}
