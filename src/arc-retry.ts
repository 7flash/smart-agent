#!/usr/bin/env bun
// smart-agent/src/arc-retry.ts
// Retry failed ARC puzzles from a previous batch run
//
// Reads all result files, finds near-misses (high similarity but not solved),
// and retries them with the current prompt. Merges results back.
//
// Usage:
//   bun run src/arc-retry.ts                         # Retry all failed puzzles
//   bun run src/arc-retry.ts --min-sim 0.5           # Only retry puzzles with ≥50% similarity
//   bun run src/arc-retry.ts --max-retries 3         # Up to 3 retries each
//   bun run src/arc-retry.ts --dry-run               # Just list what would be retried

import { measure, configure } from "measure-fn"
import { Session } from "./session"
import { fetchPuzzle, gridsEqual, parseGrid, gridDimensions, ARC_SYSTEM_PROMPT } from "./arc"
import type { ArcPuzzle } from "./arc"
import { parseArgs } from "util"
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import type { AgentMetrics, PuzzleResult } from "./arc-batch"

configure({ maxResultLength: 0, timestamps: true })

const { values: args } = parseArgs({
    options: {
        "results-dir": { type: "string", default: "./arc-results" },
        "min-sim": { type: "string", default: "0" },
        "max-sim": { type: "string", default: "0.999" },
        "max-retries": { type: "string", default: "1" },
        model: { type: "string", default: "gemini-2.5-flash" },
        "max-turns": { type: "string", default: "10" },
        "dry-run": { type: "boolean", default: false },
    },
    strict: false,
})

const RESULTS_DIR = String(args["results-dir"] || "./arc-results")
const MIN_SIM = parseFloat(String(args["min-sim"] || "0"))
const MAX_SIM = parseFloat(String(args["max-sim"] || "0.999"))
const MAX_RETRIES = parseInt(String(args["max-retries"] || "1"))
const MODEL = String(args.model || "gemini-2.5-flash")
const MAX_TURNS = parseInt(String(args["max-turns"] || "10"))
const DRY_RUN = args["dry-run"] || false

// ── Gemini pricing ──
const COST_PER_1M_INPUT = 0.30
const COST_PER_1M_OUTPUT = 2.50

function calculateCost(input: number, output: number, thinking: number): number {
    return (input * COST_PER_1M_INPUT / 1_000_000) + ((output + thinking) * COST_PER_1M_OUTPUT / 1_000_000)
}

// ── Load failed results ──

function loadFailedResults(): Array<{ id: string; similarity: number; turns: number; result: any }> {
    const files = readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json') && f !== 'state.json')
    const failed: Array<{ id: string; similarity: number; turns: number; result: any }> = []

    for (const f of files) {
        try {
            const r = JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf8'))
            if (!r.solved && !r.error && r.similarity >= MIN_SIM && r.similarity <= MAX_SIM) {
                failed.push({ id: r.id, similarity: r.similarity, turns: r.turns, result: r })
            }
        } catch { /* skip unreadable */ }
    }

    // Sort by similarity descending — retry the near-misses first
    failed.sort((a, b) => b.similarity - a.similarity)
    return failed
}

// ── Retry one puzzle ──

async function retryPuzzle(puzzleId: string, puzzle: ArcPuzzle): Promise<{ solved: boolean; similarity: number; turns: number; timeMs: number; metrics: AgentMetrics }> {
    const start = Date.now()
    const metrics: AgentMetrics = {
        promptTokens: 0, completionTokens: 0, thinkingTokens: 0,
        totalCostUsd: 0, turnCount: 0,
    }

    let lastGrid: number[][] | null = null
    let solved = false
    let turns = 0

    try {
        const session = new Session({
            model: MODEL,
            maxIterations: MAX_TURNS,
            temperature: 0.3, // Slightly higher for diversity on retry
            requireConfirmation: false,
            noStreaming: true,
        })

        for await (const event of session.send(`solve ARC puzzle ${puzzleId}`)) {
            const ev = event as any
            if (ev.type === "iteration_start") {
                turns = (ev.iteration ?? 0) + 1
                metrics.turnCount = turns
            }
            if (ev.type === "usage" && ev.usage) {
                metrics.promptTokens += ev.usage.inputTokens || 0
                metrics.completionTokens += ev.usage.outputTokens || 0
                metrics.thinkingTokens += ev.usage.thinkingTokens || 0
                metrics.totalCostUsd = calculateCost(metrics.promptTokens, metrics.completionTokens, metrics.thinkingTokens)
            }
            if (ev.type === "tool_result" && ev.tool === "submit_answer" && ev.result?.success) {
                const gridText = (ev.result.output || "") as string
                const parsed = parseGrid(gridText.replace(/^Answer submitted.*?:\n/, ""))
                if (parsed) lastGrid = parsed
            }
            if (ev.type === "objective_check") {
                for (const check of (ev.results || [])) {
                    if (check.name === "solve_puzzle" && check.met) solved = true
                }
            }
            if (ev.type === "complete") break
        }

        // Fallback similarity check
        if (lastGrid && puzzle.test[0]?.output) {
            if (gridsEqual(lastGrid, puzzle.test[0].output)) solved = true
        }
    } catch (e: any) {
        console.log(`    ⚠️ Error: ${e.message}`)
    }

    let similarity = 0
    if (lastGrid && puzzle.test[0]?.output) {
        const expected = puzzle.test[0].output
        if (solved) {
            similarity = 1
        } else {
            let total = 0, correct = 0
            const rows = Math.min(lastGrid.length, expected.length)
            for (let i = 0; i < rows; i++) {
                const cols = Math.min(lastGrid[i].length, expected[i].length)
                for (let j = 0; j < cols; j++) {
                    total++
                    if (lastGrid[i][j] === expected[i][j]) correct++
                }
            }
            similarity = total > 0 ? correct / total : 0
        }
    }

    return { solved, similarity, turns, timeMs: Date.now() - start, metrics }
}

// ── Main ──

async function main() {
    const failed = loadFailedResults()

    console.log(`\n🔄 ARC Retry Runner`)
    console.log(`   Model: ${MODEL}`)
    console.log(`   Max turns: ${MAX_TURNS}`)
    console.log(`   Similarity range: ${(MIN_SIM * 100).toFixed(0)}%-${(MAX_SIM * 100).toFixed(0)}%`)
    console.log(`   Candidates: ${failed.length}`)
    console.log(`   Max retries: ${MAX_RETRIES}\n`)

    if (failed.length === 0) {
        console.log("   No failed puzzles matching criteria found.")
        return
    }

    // Show candidates
    console.log(`   ── Retry Candidates ──`)
    for (const f of failed.slice(0, 20)) {
        console.log(`   ${f.id}: ${(f.similarity * 100).toFixed(0)}% sim, ${f.turns} turns`)
    }
    if (failed.length > 20) console.log(`   ... and ${failed.length - 20} more`)

    if (DRY_RUN) {
        console.log(`\n   (dry run — exiting)`)
        return
    }

    console.log(`\n   ── Running Retries ──`)
    let newSolved = 0
    let totalRetryCost = 0

    for (let i = 0; i < failed.length; i++) {
        const { id, similarity: origSim } = failed[i]
        console.log(`\n  [${i + 1}/${failed.length}] ${id} (was ${(origSim * 100).toFixed(0)}%)`)

        const puzzle = await fetchPuzzle(id)
        let bestResult = failed[i].result

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            if (MAX_RETRIES > 1) console.log(`    Attempt ${attempt + 1}/${MAX_RETRIES}`)

            const result = await measure(`Retry ${id}`, () => retryPuzzle(id, puzzle))
            if (!result) continue
            totalRetryCost += result.metrics.totalCostUsd

            if (result.solved) {
                console.log(`    ✅ SOLVED! (${result.turns} turns, $${result.metrics.totalCostUsd.toFixed(4)})`)
                newSolved++

                // Update the result file
                const updated = {
                    ...bestResult,
                    solved: true,
                    similarity: 1,
                    turns: result.turns,
                    timeMs: result.timeMs,
                    metrics: result.metrics,
                    retried: true,
                    retryAttempt: attempt + 1,
                    originalSimilarity: origSim,
                }
                writeFileSync(join(RESULTS_DIR, `${id}.json`), JSON.stringify(updated, null, 2))
                break
            } else {
                console.log(`    ❎ Still failed: ${(result.similarity * 100).toFixed(0)}% sim (${result.turns} turns, $${result.metrics.totalCostUsd.toFixed(4)})`)

                // If retry got higher similarity, update the result
                if (result.similarity > bestResult.similarity) {
                    console.log(`    ↑ Improved from ${(bestResult.similarity * 100).toFixed(0)}% → ${(result.similarity * 100).toFixed(0)}%`)
                    const updated = {
                        ...bestResult,
                        similarity: result.similarity,
                        turns: result.turns,
                        timeMs: result.timeMs,
                        metrics: result.metrics,
                        retried: true,
                        retryAttempt: attempt + 1,
                        originalSimilarity: origSim,
                    }
                    writeFileSync(join(RESULTS_DIR, `${id}.json`), JSON.stringify(updated, null, 2))
                    bestResult = updated
                }
            }
        }
    }

    // Summary
    console.log(`\n${"═".repeat(50)}`)
    console.log(`🔄 Retry Summary`)
    console.log(`${"═".repeat(50)}`)
    console.log(`   Retried:     ${failed.length} puzzles`)
    console.log(`   New solves:  ${newSolved}`)
    console.log(`   Retry cost:  $${totalRetryCost.toFixed(4)}`)

    // Re-read all results to give updated total
    const allFiles = readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json') && f !== 'state.json')
    let totalSolved = 0
    for (const f of allFiles) {
        const r = JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf8'))
        if (r.solved) totalSolved++
    }
    console.log(`   Total solved: ${totalSolved}/${allFiles.length} (${(totalSolved / allFiles.length * 100).toFixed(1)}%)`)
    console.log(`${"═".repeat(50)}\n`)
}

main().catch(console.error)
