#!/usr/bin/env bun
// arc-solver.tsx — Solve ARC-AGI puzzles using jsx-ai
//
// Usage:
//   bun run arc-solver.tsx                  # run all built-in puzzles
//   bun run arc-solver.tsx 0d3d703e         # run specific puzzle by ID

import { measure, measureSync, configure } from "measure-fn"
import { callLLM } from "jsx-ai"

configure({ timestamps: true, maxResultLength: 2000 })

// ── Puzzle definitions ──

interface ArcPuzzle {
    id: string
    train: { input: number[][]; output: number[][] }[]
    test: { input: number[][]; output: number[][] }[]
}

// ── Grid utilities ──

function gridToText(grid: number[][]): string {
    return grid.map(row => row.join(" ")).join("\n")
}

function gridSummary(grid: number[][]): string {
    return `${grid.length}×${grid[0].length}`
}

// ── JSX Prompt Components ──

function TrainingExample({ index, example }: { index: number; example: { input: number[][]; output: number[][] } }) {
    return (
        <message role="user">{`=== Training Example ${index + 1} ===
Input (${example.input.length}×${example.input[0].length}):
${gridToText(example.input)}

Output (${example.output.length}×${example.output[0].length}):
${gridToText(example.output)}`}</message>
    )
}

function TestInput({ grid }: { grid: number[][] }) {
    return (
        <message role="user">{`=== Test Input (${grid.length}×${grid[0].length}) ===
${gridToText(grid)}

=== Your Task ===
1. Study ALL training examples. Identify the exact transformation rule.
2. Describe the rule in 1-2 sentences.
3. Apply the rule to the test input.
4. Output the result grid in this exact format:

ANSWER:
(grid rows, one per line, space-separated values)

Output NOTHING after the grid rows.`}</message>
    )
}

function ArcPrompt({ puzzle }: { puzzle: ArcPuzzle }) {
    return (
        <>
            <system>You are an expert at abstract pattern recognition and spatial reasoning. Solve ARC-AGI puzzles by finding the transformation rule from training examples and applying it to the test input. Be precise and systematic. Always end with ANSWER: followed by the grid.</system>
            {puzzle.train.map((ex, i) => (
                <TrainingExample key={i} index={i} example={ex} />
            ))}
            <TestInput grid={puzzle.test[0].input} />
        </>
    )
}

// ── Parse the answer grid from LLM response ──

function parseAnswer(text: string): number[][] | null {
    const marker = text.indexOf("ANSWER:")
    if (marker < 0) return null

    const afterMarker = text.slice(marker + "ANSWER:".length).trim()
    const lines = afterMarker.split("\n")
        .map(l => l.trim())
        .filter(l => l.length > 0 && /^[\d\s]+$/.test(l))

    if (lines.length === 0) return null

    return lines.map(line =>
        line.split(/\s+/).map(Number)
    )
}

// ── Compare grids ──

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

// ── Puzzle IDs ──

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

    measureSync(`ARC Solver — ${model} — ${ids.length} puzzles`)

    const results: { id: string; correct: boolean; similarity: number }[] = []

    for (const id of ids) {
        const result = await measure(`Puzzle ${id}`, async (m) => {
            // Fetch puzzle
            const puzzle = await m('Fetch puzzle', async () => {
                const url = `https://raw.githubusercontent.com/fchollet/ARC-AGI/master/data/training/${id}.json`
                const res = await fetch(url)
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                const data = await res.json()
                return { id, ...data } as ArcPuzzle
            })

            if (!puzzle) return { correct: false, similarity: 0 }

            measureSync(`${puzzle.train.length} examples, input ${gridSummary(puzzle.test[0].input)} → output ${gridSummary(puzzle.test[0].output)}`)

            // Call LLM with JSX prompt
            const response = await m('Call LLM', () =>
                callLLM(<ArcPrompt puzzle={puzzle} />, {
                    model,
                    temperature: 0.1,
                    maxTokens: 8000,
                })
            )

            if (!response) return { correct: false, similarity: 0 }

            // Parse answer
            const predicted = measureSync('Parse answer', () => {
                const grid = parseAnswer(response.text)
                if (!grid) throw new Error("No ANSWER: block in LLM response")
                return grid
            })

            if (!predicted) return { correct: false, similarity: 0 }

            // Compare
            const expected = puzzle.test[0].output
            const correct = gridsEqual(predicted, expected)
            const similarity = correct ? 1.0 : gridSimilarity(predicted, expected)

            if (correct) {
                measureSync(`✓ CORRECT — predicted ${gridSummary(predicted)} matches expected`)
            } else {
                measureSync(`✗ WRONG — ${(similarity * 100).toFixed(0)}% cell match (${gridSummary(predicted)} vs ${gridSummary(expected)})`)
            }

            return { correct, similarity }
        })

        results.push({ id, ...(result ?? { correct: false, similarity: 0 }) })
    }

    // Summary
    const correct = results.filter(r => r.correct).length
    const total = results.length
    const avgSim = results.reduce((s, r) => s + r.similarity, 0) / total

    measureSync(`RESULTS: ${correct}/${total} correct (${(correct / total * 100).toFixed(0)}%) — avg similarity ${(avgSim * 100).toFixed(0)}%`)

    for (const r of results) {
        const icon = r.correct ? "✓" : "✗"
        measureSync(`${icon} ${r.id} — ${r.correct ? "correct" : `${(r.similarity * 100).toFixed(0)}% similar`}`)
    }
}

main().catch(err => {
    console.error("\x1b[31mFatal:\x1b[0m", err.message)
    process.exit(1)
})
