#!/usr/bin/env bun
// smart-agent/src/arc-batch.ts
// ARC-AGI Benchmark Harness — Intelligence Efficiency Measurement
//
// Features:
//   - Token & USD cost tracking (Gemini 2.5 Flash pricing)
//   - Pass@2 scoring (official ARC standard)
//   - Per-puzzle and aggregate metrics
//   - Resume support for interrupted runs
//
// Usage:
//   bun run src/arc-batch.ts                    # Run all 400 training puzzles
//   bun run src/arc-batch.ts --split evaluation # Run evaluation puzzles
//   bun run src/arc-batch.ts --ids 0d3d703e,1cf80156  # Run specific puzzles
//   bun run src/arc-batch.ts --resume           # Resume from last run
//   bun run src/arc-batch.ts --concurrency 3    # Run 3 puzzles in parallel
//   bun run src/arc-batch.ts --pass2            # Enable Pass@2 (2 attempts per puzzle)

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
        pass2: { type: "boolean", default: false },
    },
    strict: false,
})

const CONCURRENCY = parseInt(String(args.concurrency || "1"))
const MAX_TURNS = parseInt(String(args["max-turns"] || "10"))
const MODEL = String(args.model || "gemini-2.5-flash")
const OUTPUT_DIR = String(args["output-dir"] || "./arc-results")
const SPLIT = String(args.split || "training") as "training" | "evaluation"
const PASS_AT_2 = args.pass2 || false

// ── Gemini 2.5 Flash Pricing (Feb 2026) ──
const COST_PER_1M_INPUT = 0.30   // $0.30 per 1M input tokens
const COST_PER_1M_OUTPUT = 2.50  // $2.50 per 1M output tokens (includes thinking)

function calculateGeminiCost(inputTokens: number, outputTokens: number, thinkingTokens: number): number {
    // Thinking tokens are billed at the output rate
    const totalOutput = outputTokens + thinkingTokens
    return (inputTokens * COST_PER_1M_INPUT / 1_000_000) + (totalOutput * COST_PER_1M_OUTPUT / 1_000_000)
}

// ── Result tracking ──

export interface AgentMetrics {
    promptTokens: number
    completionTokens: number
    thinkingTokens: number
    totalCostUsd: number
    turnCount: number
}

interface PuzzleResult {
    id: string
    solved: boolean
    similarity: number // 0-1 for best attempt
    turns: number
    timeMs: number
    error?: string
    submittedGrid?: string
    expectedGrid?: string
    metrics: AgentMetrics
    // Pass@2: results of both attempts
    attempts?: { solved: boolean; similarity: number; turns: number; timeMs: number; metrics: AgentMetrics }[]
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
        // Cost & efficiency metrics
        totalCostUsd: number
        totalPromptTokens: number
        totalCompletionTokens: number
        totalThinkingTokens: number
        avgCostPerTask: number
        avgTurns: number
        // Pass@2
        passAt2Score: number
        scoring: 'pass@1' | 'pass@2'
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

// ── Solve a single puzzle (one attempt) ──

async function solvePuzzleAttempt(puzzleId: string, puzzle: ArcPuzzle): Promise<PuzzleResult> {
    const start = Date.now()

    const metrics: AgentMetrics = {
        promptTokens: 0,
        completionTokens: 0,
        thinkingTokens: 0,
        totalCostUsd: 0,
        turnCount: 0,
    }

    const result: PuzzleResult = {
        id: puzzleId,
        solved: false,
        similarity: 0,
        turns: 0,
        timeMs: 0,
        metrics,
    }

    try {
        const session = new Session({
            model: MODEL,
            maxIterations: MAX_TURNS,
            temperature: 0.2,
            requireConfirmation: false,
            noStreaming: true,  // Structured calls for token usage tracking
        })

        let lastSubmittedGrid: number[][] | null = null

        for await (const event of session.send(`solve ARC puzzle ${puzzleId}`)) {
            const ev = event as any

            // Log thinking (the agent's actual reasoning text)
            if (ev.type === "thinking" && ev.message) {
                console.log(`  💭 [Turn ${result.turns}] ${ev.message.slice(0, 500)}${ev.message.length > 500 ? '...' : ''}`)
            }

            // Log iteration start
            if (ev.type === "iteration_start") {
                result.turns = (ev.iteration ?? 0) + 1
                metrics.turnCount = result.turns
                console.log(`  🔄 Turn ${result.turns}/${MAX_TURNS}`)
            }

            // Track token usage from usage events (emitted by Agent in noStreaming mode)
            if (ev.type === "usage" && ev.usage) {
                metrics.promptTokens += ev.usage.inputTokens || 0
                metrics.completionTokens += ev.usage.outputTokens || 0
                metrics.thinkingTokens += ev.usage.thinkingTokens || 0
                metrics.totalCostUsd = calculateGeminiCost(
                    metrics.promptTokens,
                    metrics.completionTokens,
                    metrics.thinkingTokens,
                )
            }

            // Track tool results — look for submit_answer
            if (ev.type === "tool_result" && ev.tool === "submit_answer" && ev.result?.success) {
                const gridText = (ev.result.output || "") as string
                const parsed = parseGrid(gridText.replace(/^Answer submitted.*?:\n/, ""))
                if (parsed) lastSubmittedGrid = parsed
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
    result.metrics = metrics
    return result
}

// ── Solve a puzzle (with Pass@2 support) ──

async function solvePuzzle(puzzleId: string): Promise<PuzzleResult> {
    const puzzle = await fetchPuzzle(puzzleId)
    const attempts = PASS_AT_2 ? 2 : 1

    const attemptResults: PuzzleResult[] = []

    for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempts > 1) console.log(`  📌 Attempt ${attempt + 1}/${attempts}`)
        const result = await solvePuzzleAttempt(puzzleId, puzzle)
        attemptResults.push(result)

        // If solved on first attempt, skip second
        if (result.solved && attempts > 1) {
            console.log(`  ✅ Solved on attempt ${attempt + 1} — skipping remaining`)
            break
        }
    }

    // Pick the best result
    const best = attemptResults.reduce((a, b) =>
        a.solved ? a : b.solved ? b : a.similarity >= b.similarity ? a : b
    )

    // Aggregate metrics across attempts
    const totalMetrics: AgentMetrics = {
        promptTokens: attemptResults.reduce((s, r) => s + r.metrics.promptTokens, 0),
        completionTokens: attemptResults.reduce((s, r) => s + r.metrics.completionTokens, 0),
        thinkingTokens: attemptResults.reduce((s, r) => s + r.metrics.thinkingTokens, 0),
        totalCostUsd: attemptResults.reduce((s, r) => s + r.metrics.totalCostUsd, 0),
        turnCount: attemptResults.reduce((s, r) => s + r.metrics.turnCount, 0),
    }

    return {
        ...best,
        timeMs: attemptResults.reduce((s, r) => s + r.timeMs, 0),
        metrics: totalMetrics,
        attempts: attempts > 1 ? attemptResults.map(r => ({
            solved: r.solved,
            similarity: r.similarity,
            turns: r.turns,
            timeMs: r.timeMs,
            metrics: r.metrics,
        })) : undefined,
    }
}

// ── Pass@2 calculation ──

export function calculatePassAt2Score(results: PuzzleResult[]): number {
    // Pass@2: puzzle is "solved" if at least one of two attempts succeeds
    const solvedTasks = results.filter(r => {
        if (!r.attempts) return r.solved  // Pass@1 fallback
        return r.attempts.some(a => a.solved)
    }).length
    return (solvedTasks / results.length) * 100
}

// ── Main batch runner ──

async function main() {
    console.log(`\n🧩 ARC-AGI Benchmark Harness`)
    console.log(`   Model: ${MODEL}`)
    console.log(`   Split: ${SPLIT}`)
    console.log(`   Max turns: ${MAX_TURNS}`)
    console.log(`   Concurrency: ${CONCURRENCY}`)
    console.log(`   Scoring: ${PASS_AT_2 ? 'Pass@2' : 'Pass@1'}`)
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
            stats: {
                total: puzzleIds.length,
                solved: 0,
                failed: 0,
                errored: 0,
                avgSimilarity: 0,
                avgTimeMs: 0,
                totalCostUsd: 0,
                totalPromptTokens: 0,
                totalCompletionTokens: 0,
                totalThinkingTokens: 0,
                avgCostPerTask: 0,
                avgTurns: 0,
                passAt2Score: 0,
                scoring: PASS_AT_2 ? 'pass@2' : 'pass@1',
            },
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
                const cost = result.metrics.totalCostUsd > 0 ? ` $${result.metrics.totalCostUsd.toFixed(4)}` : ''
                const tokens = result.metrics.promptTokens > 0 ? ` ${result.metrics.promptTokens}+${result.metrics.completionTokens}tok` : ''
                console.log(`  ${icon} [${completed}/${total}] ${puzzleId}${sim} — ${result.turns} turns, ${(result.timeMs / 1000).toFixed(1)}s${cost}${tokens}`)

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
                    metrics: { promptTokens: 0, completionTokens: 0, thinkingTokens: 0, totalCostUsd: 0, turnCount: 0 },
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

        // Token & cost aggregates (null-safe for old results without metrics)
        state.stats.totalPromptTokens = state.results.reduce((s, r) => s + (r.metrics?.promptTokens || 0), 0)
        state.stats.totalCompletionTokens = state.results.reduce((s, r) => s + (r.metrics?.completionTokens || 0), 0)
        state.stats.totalThinkingTokens = state.results.reduce((s, r) => s + (r.metrics?.thinkingTokens || 0), 0)
        state.stats.totalCostUsd = state.results.reduce((s, r) => s + (r.metrics?.totalCostUsd || 0), 0)
        state.stats.avgCostPerTask = state.results.length > 0
            ? state.stats.totalCostUsd / state.results.length
            : 0
        state.stats.avgTurns = validResults.length > 0
            ? validResults.reduce((s, r) => s + r.turns, 0) / validResults.length
            : 0

        // Pass@2 score
        state.stats.passAt2Score = PASS_AT_2 ? calculatePassAt2Score(state.results) : 0

        saveState(state)
    }

    // Final report
    const solveRate = (state.stats.solved / state.stats.total * 100).toFixed(1)
    const efficiencyRatio = state.stats.totalCostUsd > 0
        ? (state.stats.solved / state.stats.total / state.stats.totalCostUsd).toFixed(2)
        : 'N/A'

    console.log(`\n${"═".repeat(60)}`)
    console.log(`📊 ARC-AGI Benchmark Results`)
    console.log(`${"═".repeat(60)}`)
    console.log(`   Model:          ${MODEL}`)
    console.log(`   Scoring:        ${PASS_AT_2 ? 'Pass@2' : 'Pass@1'}`)
    console.log(``)
    console.log(`   Total:          ${state.stats.total}`)
    console.log(`   ✅ Solved:       ${state.stats.solved} (${solveRate}%)`)
    console.log(`   ❎ Failed:       ${state.stats.failed}`)
    console.log(`   ❌ Errors:       ${state.stats.errored}`)
    if (PASS_AT_2) {
        console.log(`   Pass@2 Score:   ${state.stats.passAt2Score.toFixed(1)}%`)
    }
    console.log(``)
    console.log(`   ── Cost & Efficiency ──`)
    console.log(`   Total cost:     $${state.stats.totalCostUsd.toFixed(4)}`)
    console.log(`   Avg cost/task:  $${state.stats.avgCostPerTask.toFixed(4)}`)
    console.log(`   Efficiency (Acc÷Cost): ${efficiencyRatio}`)
    console.log(`   Avg turns:      ${state.stats.avgTurns.toFixed(1)}`)
    console.log(`   Avg time:       ${(state.stats.avgTimeMs / 1000).toFixed(1)}s`)
    console.log(``)
    console.log(`   ── Token Usage ──`)
    console.log(`   Input tokens:   ${state.stats.totalPromptTokens.toLocaleString()}`)
    console.log(`   Output tokens:  ${state.stats.totalCompletionTokens.toLocaleString()}`)
    console.log(`   Thinking tokens: ${state.stats.totalThinkingTokens.toLocaleString()}`)
    console.log(`   Avg match:      ${(state.stats.avgSimilarity * 100).toFixed(1)}%`)
    console.log(`${"═".repeat(60)}\n`)

    // Comparison table
    console.log(`   ── Comparison vs Baselines ──`)
    console.log(`   Metric              Base Flash    Top 2026    Smart-Agent`)
    console.log(`   Score (${PASS_AT_2 ? 'Pass@2' : 'Pass@1'})     ~9.6%         ~23.6%      ${solveRate}%`)
    console.log(`   Cost/Task           ~$0.01        ~$1.08      $${state.stats.avgCostPerTask.toFixed(4)}`)
    console.log(`   Avg Turns            1             3.5         ${state.stats.avgTurns.toFixed(1)}`)
    console.log(`${"═".repeat(60)}\n`)

    // Save final report
    const reportPath = join(OUTPUT_DIR, "report.txt")
    writeFileSync(reportPath, [
        `ARC-AGI Benchmark Report`,
        `Model: ${MODEL}`,
        `Split: ${SPLIT}`,
        `Scoring: ${PASS_AT_2 ? 'Pass@2' : 'Pass@1'}`,
        `Date: ${new Date().toISOString()}`,
        ``,
        `── Summary ──`,
        `Total: ${state.stats.total}`,
        `Solved: ${state.stats.solved} (${solveRate}%)`,
        `Failed: ${state.stats.failed}`,
        `Errors: ${state.stats.errored}`,
        PASS_AT_2 ? `Pass@2 Score: ${state.stats.passAt2Score.toFixed(1)}%` : '',
        ``,
        `── Cost & Efficiency ──`,
        `Total Cost: $${state.stats.totalCostUsd.toFixed(4)}`,
        `Avg Cost/Task: $${state.stats.avgCostPerTask.toFixed(4)}`,
        `Intelligence Efficiency (Acc÷Cost): ${efficiencyRatio}`,
        `Avg Turns: ${state.stats.avgTurns.toFixed(1)}`,
        `Avg Time: ${(state.stats.avgTimeMs / 1000).toFixed(1)}s`,
        ``,
        `── Token Usage ──`,
        `Input: ${state.stats.totalPromptTokens.toLocaleString()}`,
        `Output: ${state.stats.totalCompletionTokens.toLocaleString()}`,
        `Thinking: ${state.stats.totalThinkingTokens.toLocaleString()}`,
        `Avg Similarity: ${(state.stats.avgSimilarity * 100).toFixed(1)}%`,
        ``,
        `── Per-puzzle results ──`,
        ...state.results.map(r =>
            `${r.solved ? "✅" : "❎"} ${r.id} — sim=${(r.similarity * 100).toFixed(0)}% turns=${r.turns} time=${(r.timeMs / 1000).toFixed(1)}s cost=$${r.metrics.totalCostUsd.toFixed(4)} tok=${r.metrics.promptTokens}+${r.metrics.completionTokens}${r.error ? ` ERROR: ${r.error}` : ""}`
        ),
    ].filter(Boolean).join("\n"))
    console.log(`📄 Report saved to ${reportPath}`)
}

main().catch(console.error)
