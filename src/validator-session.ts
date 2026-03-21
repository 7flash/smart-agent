// smart-agent/src/validator-session.ts
// Validator and Heartbeat extensions for Session
import { Agent } from "./agent"
import { AgentState, Message } from "./types"
import { measureSync } from "measure-fn"
import type { Session } from "./session"

export type ValidatorObjective = {
    name: string
    description: string
    validate: (state?: AgentState) => { met: boolean; reason: string } | Promise<{ met: boolean; reason: string }>
}

export interface SessionEvent extends AsyncGenerator<any> {
    type: string
    iteration?: number
    message?: string
    results?: Array<{ name: string; met: boolean; reason: string }>
}

/**
 * Run agent in validator mode - iterates until all validators pass.
 * This is the "deep thinking" phase after user confirms objectives.
 */
export async function* runWithValidators(
    session: Session,
    message: string,
    objectives: ValidatorObjective[],
    maxIterations?: number
): AsyncGenerator<any> {
    yield { type: "replanning", message: "Switching to validator mode - deep iteration until validators pass" }

    const cwd = session.config?.cwd ?? process.cwd()
    const maxIters = maxIterations || session.config?.maxIterations || 10

    const agent = new Agent({
        ...session.config,
        objectives: objectives,
        maxIterations: maxIters,
    })

    const validatorPrompt = message + "\n\n[Validator Mode] You are in deep iteration mode. Each iteration: run tools -> check validators -> if failed, analyze why -> fix -> re-validate. Keep iterating until ALL validators pass."

    const input: Message[] = [
        { role: "user", content: validatorPrompt }
    ]

    for await (const event of agent.run(input)) {
        yield event

        if (event.type === "objective_check") {
            const allMet = (event as any).results?.every((r: any) => r.met) ?? false
            if (allMet) {
                yield { type: "planning", objectives: [{ name: "validator_passed", description: "All validators passed", type: "custom_check", params: {} }] }
            }
        }
    }
}

/**
 * Start background heartbeat - validates long-term objectives independently
 */
export class SessionHeartbeat {
    private objectives: ValidatorObjective[] = []
    private intervalId: number | null = null
    private completed = new Set<string>()
    private onObjectiveMet?: (name: string, reason: string) => void

    constructor(
        objectives: ValidatorObjective[] = [],
        intervalMs: number = 30000,
        onObjectiveMet?: (name: string, reason: string) => void
    ) {
        this.objectives = objectives
        this.onObjectiveMet = onObjectiveMet
        
        if (objectives.length > 0) {
            this.start(intervalMs)
        }
    }

    start(intervalMs: number = 30000): void {
        this.check() // Initial check
        
        this.intervalId = setInterval(() => {
            this.check()
        }, intervalMs) as any as number
    }

    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }
    }

    addObjective(obj: ValidatorObjective): void {
        if (!this.objectives.find(o => o.name === obj.name)) {
            this.objectives.push(obj)
        }
    }

    private async check(): Promise<void> {
        for (const obj of this.objectives) {
            if (this.completed.has(obj.name)) continue

            try {
                const result = await obj.validate()
                if (result.met && !this.completed.has(obj.name)) {
                    this.completed.add(obj.name)
                    this.onObjectiveMet?.(obj.name, result.reason)
                }
            } catch (e: any) {
                console.warn("[heartbeat] " + obj.name + " validation error:", e.message)
            }
        }
    }

    getStatus(): { running: boolean; completed: string[]; pending: number } {
        return {
            running: this.intervalId !== null,
            completed: [...this.completed],
            pending: this.objectives.filter(o => !this.completed.has(o.name)).length
        }
    }
}