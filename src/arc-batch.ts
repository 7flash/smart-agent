#!/usr/bin/env bun
// smart-agent/src/arc-batch.ts
// Batch ARC-AGI solver — runs all 400 puzzles, tracks results, uses bgrun for process management
//
// Usage:
//   bun run src/arc-batch.ts                    # Run all 400 training puzzles
//   bun run src/arc-batch.ts --split evaluation # Run evaluation puzzles
//   bun run src/arc-batch.ts --ids 0d3d703e,1cf80156  # Run specific puzzles
//   bun run src/arc-batch.ts --resume           # Resume from last run
//   bun run src/arc-batch.ts --concurrency 3    # Run 3 puzzles in parallel

import { measure, measureSync, configure } from "measure-fn"
import { Session } from "./session"
import { fetchPuzzle, fetchPuzzleIndex, gridsEqual, parseGrid } from "./arc"
import type { ArcPuzzle } from "./arc"
import type { SessionEvent } from "./session"
import { parseArgs } from "util"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

// Full logging — 0 = unlimited output
configure({ maxResultLength: 0, timestamps: true })


const { values: args } = parseArgs({
    options: {
        split: { type: "string", default: "training" },
        ids: { type: "string", default: "" },
        resume: { type: "boolean", default: false },
        concurrency: { type: "string", default: "1" },
        model: { type: "string", default: "gemini-2.5-flash" },
        "max-turns": { type: "string", default: "10" },
        "output-dir": { type: "string", default: "./arc-results" },
    },
    strict: false,
})

const CONCURRENCY = parseInt(String(args.concurrency || "1"))
const MAX_TURNS = parseInt(String(args["max-turns"] || "10"))
const MODEL = String(args.model || "gemini-2.5-flash")
const OUTPUT_DIR = String(args["output-dir"] || "./arc-results")
const SPLIT = String(args.split || "training") as "training" | "evaluation"

// ── Result tracking ──

interface PuzzleResult {
    id: string
    solved: boolean
    similarity: number // 0-1 for best attempt
    turns: number
    timeMs: number
    error?: string
    submittedGrid?: string
    expectedGrid?: string
}

interface BatchState {
    startedAt: string
    completedIds: string[]
    results: PuzzleResult[]
    stats: {
        total: number
        solved: number
        failed: number
        errored: number
        avgSimilarity: number
        avgTimeMs: number
    }
}

function loadState(): BatchState | null {
    const path = join(OUTPUT_DIR, "state.json")
    if (!existsSync(path)) return null
    try {
        return JSON.parse(readFileSync(path, "utf-8"))
    } catch { return null }
}

function saveState(state: BatchState) {
    mkdirSync(OUTPUT_DIR, { recursive: true })
    writeFileSync(join(OUTPUT_DIR, "state.json"), JSON.stringify(state, null, 2))
}

function savePuzzleResult(result: PuzzleResult) {
    mkdirSync(OUTPUT_DIR, { recursive: true })
    writeFileSync(
        join(OUTPUT_DIR, `${result.id}.json`),
        JSON.stringify(result, null, 2),
    )
}

// ── Solve a single puzzle ──

async function solvePuzzle(puzzleId: string): Promise<PuzzleResult> {
    const start = Date.now()

    const result: PuzzleResult = {
        id: puzzleId,
        solved: false,
        similarity: 0,
        turns: 0,
        timeMs: 0,
    }

    try {
        const puzzle = await fetchPuzzle(puzzleId)

        const session = new Session({
            model: MODEL,
            maxIterations: MAX_TURNS,
            temperature: 0.2,
            requireConfirmation: false,
        })

        let lastSubmittedGrid: number[][] | null = null

        for await (const event of session.send(`solve ARC puzzle ${puzzleId}`)) {
            const ev = event as any

            // Track tool results — look for submit_answer
            if (ev.type === "tool_result" && ev.tool === "submit_answer" && ev.result?.success) {
                const gridText = (ev.result.output || "") as string
                const parsed = parseGrid(gridText.replace(/^Answer submitted.*?:\n/, ""))
                if (parsed) lastSubmittedGrid = parsed
            }

            // Track iteration count
            if (ev.type === "iteration_start") {
                result.turns = (ev.iteration ?? 0) + 1
            }

            // Check if objective is met
            if (ev.type === "objective_check") {
                const checks = ev.results || []
                for (const check of checks) {
                    if (check.name === "solve_puzzle" && check.met) {
                        result.solved = true
                        result.similarity = 1
                    }
                }
            }

            if (ev.type === "complete") break
        }

        // If we have a submission, calculate similarity even if not marked solved
        if (lastSubmittedGrid && puzzle.test[0]?.output) {
            const expected = puzzle.test[0].output
            if (gridsEqual(lastSubmittedGrid, expected)) {
                result.solved = true
                result.similarity = 1
            } else {
                // Calculate cell-level similarity
                let total = 0, correct = 0
                const rows = Math.min(lastSubmittedGrid.length, expected.length)
                for (let i = 0; i < rows; i++) {
                    const cols = Math.min(lastSubmittedGrid[i].length, expected[i].length)
                    for (let j = 0; j < cols; j++) {
                        total++
                        if (lastSubmittedGrid[i][j] === expected[i][j]) correct++
                    }
                }
                result.similarity = total > 0 ? correct / total : 0
            }
            result.submittedGrid = lastSubmittedGrid.map(r => r.join(" ")).join("\n")
            result.expectedGrid = expected.map(r => r.join(" ")).join("\n")
        }
    } catch (e: any) {
        result.error = e.message
    }

    result.timeMs = Date.now() - start
    return result
}

// ── Main batch runner ──

async function main() {
    console.log(`\n🧩 ARC-AGI Batch Solver`)
    console.log(`   Model: ${MODEL}`)
    console.log(`   Split: ${SPLIT}`)
    console.log(`   Max turns: ${MAX_TURNS}`)
    console.log(`   Concurrency: ${CONCURRENCY}`)
    console.log(`   Output: ${OUTPUT_DIR}\n`)

    // Determine puzzle IDs to solve
    let puzzleIds: string[]

    if (args.ids) {
        puzzleIds = String(args.ids).split(",").map((s: string) => s.trim())
        console.log(`📋 Running ${puzzleIds.length} specific puzzles`)
    } else {
        puzzleIds = await measure("Fetch puzzle index", () => fetchPuzzleIndex(SPLIT)) ?? []
        console.log(`📋 Found ${puzzleIds.length} ${SPLIT} puzzles`)
    }

    // Resume from previous run if requested
    let state: BatchState
    const existingState = args.resume ? loadState() : null

    if (existingState) {
        state = existingState
        const remaining = puzzleIds.filter(id => !state.completedIds.includes(id))
        console.log(`♻️  Resuming — ${state.completedIds.length} done, ${remaining.length} remaining`)
        puzzleIds = remaining
    } else {
        state = {
            startedAt: new Date().toISOString(),
            completedIds: [],
            results: [],
            stats: { total: puzzleIds.length, solved: 0, failed: 0, errored: 0, avgSimilarity: 0, avgTimeMs: 0 },
        }
    }

    state.stats.total = state.completedIds.length + puzzleIds.length

    // Run puzzles with concurrency
    const chunks: string[][] = []
    for (let i = 0; i < puzzleIds.length; i += CONCURRENCY) {
        chunks.push(puzzleIds.slice(i, i + CONCURRENCY))
    }

    let completed = state.completedIds.length
    const total = state.stats.total

    for (const chunk of chunks) {
        const results = await Promise.allSettled(
            chunk.map(id => measure(`Puzzle ${id}`, () => solvePuzzle(id)))
        )

        for (let i = 0; i < results.length; i++) {
            completed++
            const entry = results[i]
            const puzzleId = chunk[i]

            if (entry.status === "fulfilled" && entry.value) {
                const result = entry.value
                state.results.push(result)
                state.completedIds.push(puzzleId)
                savePuzzleResult(result)

                const icon = result.solved ? "✅" : result.error ? "❌" : "❎"
                const sim = result.solved ? "" : ` (${(result.similarity * 100).toFixed(0)}%)`
                console.log(`  ${icon} [${completed}/${total}] ${puzzleId}${sim} — ${result.turns} turns, ${(result.timeMs / 1000).toFixed(1)}s`)

                if (result.solved) state.stats.solved++
                else if (result.error) state.stats.errored++
                else state.stats.failed++
            } else {
                const error = entry.status === "rejected" ? (entry.reason?.message || "unknown") : "no result"
                state.results.push({
                    id: puzzleId,
                    solved: false,
                    similarity: 0,
                    turns: 0,
                    timeMs: 0,
                    error,
                })
                state.completedIds.push(puzzleId)
                state.stats.errored++
                console.log(`  ❌ [${completed}/${total}] ${puzzleId} — ERROR: ${error}`)
            }
        }

        // Update aggregate stats
        const validResults = state.results.filter(r => !r.error)
        state.stats.avgSimilarity = validResults.length > 0
            ? validResults.reduce((sum, r) => sum + r.similarity, 0) / validResults.length
            : 0
        state.stats.avgTimeMs = validResults.length > 0
            ? validResults.reduce((sum, r) => sum + r.timeMs, 0) / validResults.length
            : 0

        saveState(state)
    }

    // Final report
    console.log(`\n${"═".repeat(50)}`)
    console.log(`📊 ARC-AGI Batch Results`)
    console.log(`${"═".repeat(50)}`)
    console.log(`   Total:       ${state.stats.total}`)
    console.log(`   ✅ Solved:    ${state.stats.solved} (${(state.stats.solved / state.stats.total * 100).toFixed(1)}%)`)
    console.log(`   ❎ Failed:    ${state.stats.failed}`)
    console.log(`   ❌ Errors:    ${state.stats.errored}`)
    console.log(`   Avg match:   ${(state.stats.avgSimilarity * 100).toFixed(1)}%`)
    console.log(`   Avg time:    ${(state.stats.avgTimeMs / 1000).toFixed(1)}s`)
    console.log(`${"═".repeat(50)}\n`)

    // Save final report
    const reportPath = join(OUTPUT_DIR, "report.txt")
    writeFileSync(reportPath, [
        `ARC-AGI Batch Report`,
        `Model: ${MODEL}`,
        `Split: ${SPLIT}`,
        `Date: ${new Date().toISOString()}`,
        ``,
        `Total: ${state.stats.total}`,
        `Solved: ${state.stats.solved} (${(state.stats.solved / state.stats.total * 100).toFixed(1)}%)`,
        `Failed: ${state.stats.failed}`,
        `Errors: ${state.stats.errored}`,
        `Avg similarity: ${(state.stats.avgSimilarity * 100).toFixed(1)}%`,
        `Avg time: ${(state.stats.avgTimeMs / 1000).toFixed(1)}s`,
        ``,
        `── Per-puzzle results ──`,
        ...state.results.map(r =>
            `${r.solved ? "✅" : "❎"} ${r.id} — sim=${(r.similarity * 100).toFixed(0)}% turns=${r.turns} time=${(r.timeMs / 1000).toFixed(1)}s${r.error ? ` ERROR: ${r.error}` : ""}`
        ),
    ].join("\n"))
    console.log(`📄 Report saved to ${reportPath}`)
}

main().catch(console.error)
