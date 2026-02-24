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

export function gridToCompact(grid: number[][]): string {
    return grid.map(row => row.join("")).join("|")
}

export function compactToGrid(compact: string): number[][] {
    return compact.split("|").map(row => row.split("").map(Number))
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
    // Strip markdown code fences
    let cleaned = text.trim()
        .replace(/^```\w*\n?/, '')
        .replace(/\n?```$/, '')
        .trim()

    // Handle JSON array format: [[1,2],[3,4]]
    if (cleaned.startsWith('[')) {
        try {
            const parsed = JSON.parse(cleaned)
            if (Array.isArray(parsed) && Array.isArray(parsed[0])) {
                return parsed.map((row: any) => row.map(Number))
            }
        } catch { /* not JSON, continue */ }
    }

    // Remove brackets, commas — normalize to space-separated rows
    cleaned = cleaned
        .replace(/\[/g, '')
        .replace(/\]/g, '')
        .replace(/,/g, ' ')

    const lines = cleaned.split("\n")
        .map(l => l.trim())
        .filter(l => l.length > 0 && /[\d]/.test(l))
        .map(l => l.replace(/[^0-9\s|]/g, '').trim()) // strip non-digit/space/pipe chars
        .filter(l => l.length > 0)

    // Handle compact format "012|345|678"
    if (lines.length === 1 && lines[0].includes("|")) {
        return compactToGrid(lines[0])
    }

    if (lines.length === 0) return null
    return lines.map(line => {
        // If digits have spaces between them, split on spaces
        if (line.includes(" ")) return line.split(/\s+/).filter(s => s.length > 0).map(Number)
        // Otherwise each char is a digit
        return line.split("").map(Number)
    })
}

export function gridDimensions(grid: number[][]): string {
    return `${grid.length}×${grid[0]?.length || 0}`
}

// ── ARC color map for text visualization ──
const COLOR_NAMES: Record<number, string> = {
    0: "⬛", 1: "🟦", 2: "🟥", 3: "🟩", 4: "🟨",
    5: "⬜", 6: "🟪", 7: "🟧", 8: "🔵", 9: "🟫",
}

export function gridToEmoji(grid: number[][]): string {
    return grid.map(row => row.map(c => COLOR_NAMES[c] || `[${c}]`).join("")).join("\n")
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

const ARC_BASE_URL = "https://raw.githubusercontent.com/fchollet/ARC-AGI/master/data"

export async function fetchPuzzle(id: string): Promise<ArcPuzzle> {
    // Try training first, then evaluation
    for (const split of ["training", "evaluation"]) {
        const url = `${ARC_BASE_URL}/${split}/${id}.json`
        const res = await fetch(url)
        if (res.ok) {
            const data = await res.json()
            return { id, ...data } as ArcPuzzle
        }
    }
    throw new Error(`Puzzle ${id} not found in training or evaluation sets`)
}

/** Fetch all puzzle IDs from a split */
export async function fetchPuzzleIndex(split: "training" | "evaluation" = "training"): Promise<string[]> {
    const url = `https://api.github.com/repos/fchollet/ARC-AGI/contents/data/${split}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch puzzle index: HTTP ${res.status}`)
    const data: any[] = await res.json()
    return data
        .filter((f: any) => f.name.endsWith(".json"))
        .map((f: any) => f.name.replace(".json", ""))
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
                    output: `Training Example ${i + 1}:\n\nInput (${gridDimensions(ex.input)}):\n${gridToText(ex.input)}\n\nOutput (${gridDimensions(ex.output)}):\n${gridToText(ex.output)}`,
                }
            },
        },
        {
            name: "view_all_training",
            description: "View ALL training examples at once. Use this first to understand the complete pattern.",
            parameters: {},
            async execute(): Promise<ToolResult> {
                const parts: string[] = []
                for (let i = 0; i < puzzle.train.length; i++) {
                    const ex = puzzle.train[i]
                    parts.push(
                        `── Example ${i + 1} ──\nInput (${gridDimensions(ex.input)}):\n${gridToText(ex.input)}\n\nOutput (${gridDimensions(ex.output)}):\n${gridToText(ex.output)}`
                    )
                }
                return { success: true, output: parts.join("\n\n") }
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
                    output: `Test Input (${gridDimensions(test.input)}):\n${gridToText(test.input)}`,
                }
            },
        },
        {
            name: "run_transform",
            description: `Write a JavaScript function body that transforms an input grid to an output grid. The function receives 'input' (number[][]) and must return a number[][]. It is tested against ALL ${puzzle.train.length} training examples automatically. This is the most powerful tool — use it to programmatically verify your hypothesis.`,
            parameters: {
                code: { type: "string", description: "JavaScript function body. Receives 'input' (number[][]). Must return number[][]. Example: 'return input.map(row => row.map(c => c === 0 ? 0 : 5 - c))'", required: true },
            },
            async execute(params): Promise<ToolResult> {
                const code = params.code as string
                try {
                    // Create the transform function
                    const fn = new Function("input", code) as (input: number[][]) => number[][]

                    const results: string[] = []
                    let allCorrect = true

                    for (let i = 0; i < puzzle.train.length; i++) {
                        const ex = puzzle.train[i]
                        try {
                            const predicted = fn(JSON.parse(JSON.stringify(ex.input))) // deep copy
                            if (!Array.isArray(predicted) || !Array.isArray(predicted[0])) {
                                results.push(`Example ${i + 1}: ✗ ERROR — function did not return a 2D array`)
                                allCorrect = false
                                continue
                            }
                            const correct = gridsEqual(predicted, ex.output)
                            if (correct) {
                                results.push(`Example ${i + 1}: ✓ CORRECT`)
                            } else {
                                allCorrect = false
                                const sim = gridSimilarity(predicted, ex.output)
                                results.push(`Example ${i + 1}: ✗ WRONG (${(sim * 100).toFixed(0)}% match)\n  Got:      ${gridToCompact(predicted)}\n  Expected: ${gridToCompact(ex.output)}`)
                            }
                        } catch (e: any) {
                            allCorrect = false
                            results.push(`Example ${i + 1}: ✗ RUNTIME ERROR — ${e.message}`)
                        }
                    }

                    // If all correct, also run on test input and show prediction
                    if (allCorrect) {
                        try {
                            const testPrediction = fn(JSON.parse(JSON.stringify(puzzle.test[0].input)))
                            results.push(`\n🎯 ALL TRAINING CORRECT! Test prediction:\n${gridToText(testPrediction)}\n\nUse submit_answer to submit this.`)
                        } catch (e: any) {
                            results.push(`\n⚠ All training correct but test input failed: ${e.message}`)
                        }
                    }

                    return {
                        success: true,
                        output: `Transform results (${allCorrect ? 'ALL PASS ✓' : 'SOME FAIL'}):\n${results.join("\n")}`,
                    }
                } catch (e: any) {
                    return { success: false, output: "", error: `Syntax error in transform code: ${e.message}` }
                }
            },
        },
        {
            name: "verify_on_training",
            description: "Test a predicted output grid against a specific training example.",
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
                    output: `✗ INCORRECT — ${(sim * 100).toFixed(0)}% cell match\n\nYour prediction (${gridDimensions(predicted)}):\n${gridToText(predicted)}\n\nExpected (${gridDimensions(expected)}):\n${gridToText(expected)}`,
                }
            },
        },
        {
            name: "submit_answer",
            description: "Submit your final answer for the test input. This is the grid you think is the correct transformation of the test input.",
            parameters: {
                grid: { type: "string", description: "Your answer grid — rows separated by newlines, values separated by spaces. Or use programmatic: set code=true and provide JS function body.", required: true },
                code: { type: "boolean", description: "If true, 'grid' is treated as JS function body (same as run_transform) and applied to the test input." },
            },
            async execute(params): Promise<ToolResult> {
                let predicted: number[][] | null

                if (params.code) {
                    // Apply code to test input
                    try {
                        const fn = new Function("input", params.grid as string) as (input: number[][]) => number[][]
                        predicted = fn(JSON.parse(JSON.stringify(puzzle.test[0].input)))
                    } catch (e: any) {
                        return { success: false, output: "", error: `Code execution failed: ${e.message}` }
                    }
                } else {
                    predicted = parseGrid(params.grid as string)
                }

                if (!predicted) {
                    return { success: false, output: "", error: "Could not parse grid." }
                }
                return {
                    success: true,
                    output: `Answer submitted (${gridDimensions(predicted)}):\n${gridToText(predicted)}`,
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
            let predicted: number[][] | null

            if (lastSubmission.params.code) {
                try {
                    const fn = new Function("input", gridText) as (input: number[][]) => number[][]
                    predicted = fn(JSON.parse(JSON.stringify(puzzle.test[0].input)))
                } catch {
                    return { met: false, reason: "Code execution failed during validation." }
                }
            } else {
                predicted = parseGrid(gridText)
            }

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
                reason: `Answer incorrect — ${(sim * 100).toFixed(0)}% cell match. Try using run_transform to write a programmatic solution and verify against all training examples.`,
            }
        },
    }
}

/** System prompt optimized for ARC puzzle solving with code-based approach */
export const ARC_SYSTEM_PROMPT = `You are solving an ARC-AGI abstract reasoning puzzle.
You must discover the transformation rule from training examples and apply it to the test input.

TOOLS AVAILABLE:
- view_all_training: See ALL training input→output pairs at once
- view_training: See a specific training example 
- view_test_input: See the test input you need to transform
- run_transform: Write JS code that transforms input→output, automatically verified against ALL training examples
- verify_on_training: Manually check a grid against a training example
- submit_answer: Submit your final answer (grid or code)

CRITICAL STRATEGY (follow EXACTLY):
Turn 1: Call view_all_training to see every example at once.
Turn 2: Analyze patterns. Write a JS transform function using run_transform to verify your hypothesis against ALL training examples at once. The function receives 'input' (number[][]) and must return number[][].
Turn 3+: If run_transform shows ALL PASS → call submit_answer with code=true using the same function. If some fail → refine your code and try again.

KEY PRINCIPLES:
- ALWAYS use run_transform to verify your rule programmatically. Do NOT guess.
- Think about: color mapping, rotation, reflection, scaling, cropping, pattern completion, object detection, flood fill, symmetry.
- Common ARC patterns: input/output size changes, color substitution, object extraction, border/padding, tiling/repetition, gravity/stacking.
- The function body receives 'input' as number[][] and must return number[][].
- EVERY response MUST include tool calls. NEVER respond with only text.
- You have 10 turns maximum. Be efficient. Do NOT waste turns analyzing without tool calls.
- ⚠️ DEADLINE RULE: If you reach turn 7 without solving, you MUST submit your BEST attempt immediately using submit_answer. Even a partial solution is better than no submission.
- If your run_transform passes most but not all examples, SUBMIT IT ANYWAY rather than running out of turns.

Grid format: space-separated integers, one row per line. 0=black, 1-9=colors.`

/** Urgency message injected on penultimate turns */
export const ARC_URGENCY_MESSAGE = `⚠️ DEADLINE: You are running out of turns. You MUST call submit_answer NOW with your best attempt. Even if your run_transform code doesn't pass all examples, submit it with code=true. A partial answer is infinitely better than no answer. DO NOT analyze further — SUBMIT NOW.`
