// smart-agent/src/arc.ts
// Reusable ARC-AGI puzzle solving tools and objectives
// Used by both the standalone arc-agent.tsx and the Session chat integration

import type { Tool, ToolResult, Objective, AgentState } from "./types"

// ── Types ──

export interface ArcPuzzle {
    id: string
    train: { input: number[][]; output: number[][] }[]
    test: { input: number[][]; output: number[][] }[]
}

// ── Grid utilities ──

export function gridToText(grid: number[][]): string {
    return grid.map(row => row.join(" ")).join("\n")
}

export function gridsEqual(a: number[][], b: number[][]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (a[i].length !== b[i].length) return false
        for (let j = 0; j < a[i].length; j++) {
            if (a[i][j] !== b[i][j]) return false
        }
    }
    return true
}

export function gridSimilarity(predicted: number[][], expected: number[][]): number {
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

export function parseGrid(text: string): number[][] | null {
    const lines = text.trim().split("\n")
        .map(l => l.trim())
        .filter(l => l.length > 0 && /^[\d\s]+$/.test(l))
    if (lines.length === 0) return null
    return lines.map(line => line.split(/\s+/).map(Number))
}

// ── Fetch puzzle from ARC-AGI GitHub repo ──

/** Well-known easy/medium puzzles for default runs */
export const DEFAULT_PUZZLE_IDS = [
    "0d3d703e", // Color mapping (easy)
    "1cf80156", // Crop non-zero region (easy)
    "0a938d79", // Stripe pattern (medium)
    "6150a2bd", // 180° rotation (medium)
    "4258a5f9", // 3×3 ring around 5s (medium)
]

export async function fetchPuzzle(id: string): Promise<ArcPuzzle> {
    const url = `https://raw.githubusercontent.com/fchollet/ARC-AGI/master/data/training/${id}.json`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch puzzle ${id}: HTTP ${res.status}`)
    const data = await res.json()
    return { id, ...data } as ArcPuzzle
}

/**
 * Extract puzzle ID from a user message like:
 *   "solve ARC puzzle 0d3d703e"
 *   "try arc-agi challenge 1cf80156"
 *   "solve an arc puzzle"  → returns random from defaults
 */
export function extractPuzzleId(message: string): string | null {
    // Look for hex puzzle ID pattern (8 hex chars)
    const idMatch = message.match(/\b([0-9a-f]{8})\b/i)
    if (idMatch) return idMatch[1].toLowerCase()

    // Check if it's an ARC request without a specific ID → use random default
    if (/\b(arc|arc-agi|abstract reasoning)\b/i.test(message) &&
        /\b(solve|try|attempt|run|challenge|puzzle)\b/i.test(message)) {
        return DEFAULT_PUZZLE_IDS[Math.floor(Math.random() * DEFAULT_PUZZLE_IDS.length)]
    }

    return null
}

// ── Build tools for the ARC agent ──

export function createArcTools(puzzle: ArcPuzzle): Tool[] {
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
                return {
                    success: true,
                    output: `Answer submitted (${predicted.length}×${predicted[0].length}):\n${gridToText(predicted)}`,
                }
            },
        },
    ]
}

// ── Build objective ──

export function createArcObjective(puzzle: ArcPuzzle): Objective {
    return {
        name: "solve_puzzle",
        description: `Solve ARC puzzle ${puzzle.id}: Study the ${puzzle.train.length} training examples to identify the transformation rule, verify your rule against training data, then submit the correct output for the test input.`,
        validate(state: AgentState) {
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

/** System prompt optimized for ARC puzzle solving */
export const ARC_SYSTEM_PROMPT = `You are solving an ARC-AGI abstract reasoning puzzle.

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
0 = empty/black, 1-9 = colors.`
