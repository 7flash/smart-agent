#!/usr/bin/env bun
// arc-agent.tsx — Agentic ARC-AGI solver using smart-agent loop
//
// This demonstrates what the agent loop can do that jsx-ai alone can't:
// - Self-correction: if the first answer is wrong, the agent sees the error and retries
// - Tool use: the agent can verify its own answer against training examples
// - Multi-step reasoning: the agent can analyze failures and adjust strategy
//
// Usage:
//   bun run arc-agent.tsx                  # run all puzzles
//   bun run arc-agent.tsx 0d3d703e         # run specific puzzle

import { measure, measureSync, configure } from "measure-fn"
import { Agent } from "./src/agent"
import type { Objective, Tool, ToolResult, AgentState } from "./src/types"

configure({ timestamps: false, maxResultLength: 0 })

// ── Puzzle types ──

interface ArcPuzzle {
    id: string
    train: { input: number[][]; output: number[][] }[]
    test: { input: number[][]; output: number[][] }[]
}

// ── Grid utilities ──

function gridToText(grid: number[][]): string {
    return grid.map(row => row.join(" ")).join("\n")
}

function gridsEqual(a: number[][], b: number[][]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (a[i].length !== b[i].length) return false
        for (let j = 0; j < a[i].length; j++) {
            if (a[i][j] !== b[i][j]) return false
        }
    }
    return true
}

function gridSimilarity(predicted: number[][], expected: number[][]): number {
    if (predicted.length !== expected.length) return 0
    let total = 0, correct = 0
    for (let i = 0; i < expected.length; i++) {
        if (predicted[i].length !== expected[i].length) return 0
        for (let j = 0; j < expected[i].length; j++) {
            total++
            if (predicted[i][j] === expected[i][j]) correct++
        }
    }
    return total === 0 ? 0 : correct / total
}

function parseGrid(text: string): number[][] | null {
    const lines = text.trim().split("\n")
        .map(l => l.trim())
        .filter(l => l.length > 0 && /^[\d\s]+$/.test(l))
    if (lines.length === 0) return null
    return lines.map(line => line.split(/\s+/).map(Number))
}

// ── Fetch puzzle ──

async function fetchPuzzle(id: string): Promise<ArcPuzzle> {
    const url = `https://raw.githubusercontent.com/fchollet/ARC-AGI/master/data/training/${id}.json`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    return { id, ...data } as ArcPuzzle
}

// ── Build tools for the agent ──

function buildArcTools(puzzle: ArcPuzzle): Tool[] {
    // Track the agent's current best answer
    let currentAnswer: number[][] | null = null

    return [
        {
            name: "view_training",
            description: "View a specific training example (input → output pair). Use this to study the pattern.",
            parameters: {
                index: { type: "number", description: "Training example index (0-based)", required: true },
            },
            async execute(params): Promise<ToolResult> {
                const i = params.index as number
                if (i < 0 || i >= puzzle.train.length) {
                    return { success: false, output: "", error: `Index ${i} out of range (0-${puzzle.train.length - 1})` }
                }
                const ex = puzzle.train[i]
                return {
                    success: true,
                    output: `Training Example ${i + 1}:\n\nInput (${ex.input.length}×${ex.input[0].length}):\n${gridToText(ex.input)}\n\nOutput (${ex.output.length}×${ex.output[0].length}):\n${gridToText(ex.output)}`,
                }
            },
        },
        {
            name: "view_test_input",
            description: "View the test input grid that you need to solve.",
            parameters: {},
            async execute(): Promise<ToolResult> {
                const test = puzzle.test[0]
                return {
                    success: true,
                    output: `Test Input (${test.input.length}×${test.input[0].length}):\n${gridToText(test.input)}`,
                }
            },
        },
        {
            name: "verify_on_training",
            description: "Test your proposed transformation rule against a training example. Submit a predicted output grid for a training example and check if it matches.",
            parameters: {
                index: { type: "number", description: "Training example index (0-based)", required: true },
                grid: { type: "string", description: "Your predicted output grid — rows separated by newlines, values separated by spaces", required: true },
            },
            async execute(params): Promise<ToolResult> {
                const i = params.index as number
                if (i < 0 || i >= puzzle.train.length) {
                    return { success: false, output: "", error: `Index ${i} out of range` }
                }
                const predicted = parseGrid(params.grid as string)
                if (!predicted) {
                    return { success: false, output: "", error: "Could not parse grid. Use space-separated numbers, one row per line." }
                }
                const expected = puzzle.train[i].output
                const correct = gridsEqual(predicted, expected)
                if (correct) {
                    return { success: true, output: `✓ CORRECT — your prediction matches training example ${i + 1}` }
                }
                const sim = gridSimilarity(predicted, expected)
                return {
                    success: true,
                    output: `✗ INCORRECT — ${(sim * 100).toFixed(0)}% cell match\n\nYour prediction (${predicted.length}×${predicted[0].length}):\n${gridToText(predicted)}\n\nExpected (${expected.length}×${expected[0].length}):\n${gridToText(expected)}`,
                }
            },
        },
        {
            name: "submit_answer",
            description: "Submit your final answer for the test input. This is the grid you think is the correct transformation of the test input.",
            parameters: {
                grid: { type: "string", description: "Your answer grid — rows separated by newlines, values separated by spaces", required: true },
            },
            async execute(params): Promise<ToolResult> {
                const predicted = parseGrid(params.grid as string)
                if (!predicted) {
                    return { success: false, output: "", error: "Could not parse grid." }
                }
                currentAnswer = predicted
                return {
                    success: true,
                    output: `Answer submitted (${predicted.length}×${predicted[0].length}):\n${gridToText(predicted)}`,
                }
            },
        },
    ]
}

// ── Build objective ──

function buildArcObjective(puzzle: ArcPuzzle): Objective {
    return {
        name: "solve_puzzle",
        description: `Solve ARC puzzle ${puzzle.id}: Study the ${puzzle.train.length} training examples to identify the transformation rule, verify your rule against training data, then submit the correct output for the test input.`,
        validate(state: AgentState) {
            // Look for the most recent submit_answer call
            const submissions = state.toolHistory.filter(t => t.tool === "submit_answer" && t.result.success)
            if (submissions.length === 0) {
                return { met: false, reason: "No answer submitted yet. Use submit_answer tool." }
            }

            const lastSubmission = submissions[submissions.length - 1]
            const gridText = lastSubmission.params.grid as string
            const predicted = parseGrid(gridText)
            if (!predicted) {
                return { met: false, reason: "Could not parse submitted answer." }
            }

            const expected = puzzle.test[0].output
            const correct = gridsEqual(predicted, expected)
            if (correct) {
                return { met: true, reason: "Answer matches expected output!" }
            }

            const sim = gridSimilarity(predicted, expected)
            return {
                met: false,
                reason: `Answer incorrect — ${(sim * 100).toFixed(0)}% cell match. Try verifying your rule on training examples first, then adjust.`,
            }
        },
    }
}

// ── Main ──

const PUZZLE_IDS = [
    "0d3d703e", // Color mapping (easy)
    "1cf80156", // Crop non-zero region (easy)
    "0a938d79", // Stripe pattern (medium)
    "6150a2bd", // 180° rotation (medium)
    "4258a5f9", // 3×3 ring around 5s (medium)
]

async function main() {
    const model = process.env.ARC_MODEL || "gemini-2.5-flash"
    const targetId = process.argv[2]
    const ids = targetId ? [targetId] : PUZZLE_IDS

    measureSync(`ARC Agent — ${model} — ${ids.length} puzzles`)

    const results: { id: string; correct: boolean; similarity: number; iterations: number }[] = []

    for (const id of ids) {
        const result = await measure(`Puzzle ${id}`, async () => {
            const puzzle = await measure('Fetch puzzle', () => fetchPuzzle(id))
            if (!puzzle) return { correct: false, similarity: 0, iterations: 0 }

            measureSync(`${puzzle.train.length} examples, test ${puzzle.test[0].input.length}×${puzzle.test[0].input[0].length}`)

            const tools = buildArcTools(puzzle)
            const objective = buildArcObjective(puzzle)

            const agent = new Agent({
                model,
                objectives: [objective],
                tools,
                maxIterations: 10,
                temperature: 0.2,
                maxTokens: 8000,
                systemPrompt: `You are solving an ARC-AGI abstract reasoning puzzle.

CRITICAL RULES:
- EVERY response MUST include tool calls in a JSON code block. NEVER respond with only analysis text.
- You have limited turns. Do NOT waste turns on thinking without tool calls.
- Call MULTIPLE tools per turn: batch all view_training calls together.

STRATEGY (follow this EXACTLY):
Turn 1: View ALL training examples at once (call view_training for index 0, 1, 2, ... in one JSON array)
Turn 2: Identify the pattern, verify on one training example with verify_on_training
Turn 3: If verified ✓ → call view_test_input. If ✗ → revise and verify again.
Turn 4: Apply the rule to the test input and call submit_answer immediately.

NEVER spend a turn only explaining your thinking. ALWAYS include tool calls.
If you know the rule, SUBMIT IMMEDIATELY. Do not over-analyze.

Grid format: space-separated integers, one row per line.
0 = empty/black, 1-9 = colors.`,
            })

            let iterations = 0
            let solved = false
            let lastSubmittedGrid: number[][] | null = null

            for await (const event of agent.run(`Solve ARC puzzle ${id}`)) {
                switch (event.type) {
                    case "iteration_start":
                        iterations = event.iteration + 1
                        measureSync(`Iteration ${iterations}`)
                        break
                    case "thinking":
                        measureSync(`LLM: ${event.message.substring(0, 300)}`)
                        break
                    case "tool_start":
                        measureSync(`→ ${event.tool}(${JSON.stringify(event.params)})`)
                        break
                    case "tool_result":
                        if (event.tool === "submit_answer" && event.result.success) {
                            // Capture the submitted grid for similarity calc
                            const lines = event.result.output.split("\n").slice(1) // skip "Answer submitted..." line
                            lastSubmittedGrid = parseGrid(lines.join("\n"))
                        }
                        if (!event.result.success) {
                            measureSync(`✗ ${event.tool}: ${event.result.error}`)
                        }
                        break
                    case "objective_check":
                        for (const r of event.results) {
                            measureSync(`${r.met ? "✓" : "○"} ${r.name}: ${r.reason}`)
                            if (r.met) solved = true
                        }
                        break
                    case "complete":
                        measureSync(`✓ Completed in ${iterations} iterations (${event.elapsed}ms)`)
                        break
                    case "max_iterations":
                        measureSync(`✗ Max iterations reached`)
                        break
                    case "error":
                        measureSync(`✗ Error: ${event.error}`)
                        break
                }
            }

            // Calculate similarity from last submitted grid
            const expected = puzzle.test[0].output
            let similarity = solved ? 1.0 : 0
            if (!solved && lastSubmittedGrid) {
                similarity = gridSimilarity(lastSubmittedGrid, expected)
            }

            return { correct: solved, similarity, iterations }
        })

        results.push({ id, ...(result ?? { correct: false, similarity: 0, iterations: 0 }) })
    }

    // Summary
    const correct = results.filter(r => r.correct).length
    const total = results.length
    const avgSim = results.reduce((s, r) => s + r.similarity, 0) / total

    measureSync(`RESULTS: ${correct}/${total} correct (${(correct / total * 100).toFixed(0)}%) — avg similarity ${(avgSim * 100).toFixed(0)}%`)

    for (const r of results) {
        const icon = r.correct ? "✓" : "✗"
        measureSync(`${icon} ${r.id} — ${r.correct ? `correct in ${r.iterations} iters` : `${(r.similarity * 100).toFixed(0)}% similar (${r.iterations} iters)`}`)
    }
}

main().catch(err => {
    console.error("\x1b[31mFatal:\x1b[0m", err.message)
    process.exit(1)
})
