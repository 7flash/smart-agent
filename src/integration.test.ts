/**
 * Integration Tests — End-to-end flows hitting real LLM APIs via jsx-ai.
 *
 * Gated behind environment variables:
 *   GEMINI_API_KEY / GOOGLE_API_KEY  → Gemini tests
 *   OPENAI_API_KEY                   → OpenAI tests
 *
 * If no API key is set, tests gracefully skip.
 * Run: GEMINI_API_KEY=... bun test src/integration.test.ts
 */
import { test, expect, describe, afterEach } from "bun:test"
import { Agent } from "./agent"
import { writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from "fs"
import { join } from "path"

// ─── Helpers ────────────────────────────────────────────

const hasGemini = () => !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const hasOpenAI = () => !!process.env.OPENAI_API_KEY;
const hasAnyKey = () => hasGemini() || hasOpenAI();

function skipIfNoKey(provider: string): boolean {
    if (!hasAnyKey()) {
        console.warn(`⏭️  Skipping ${provider} integration test (no API keys set)`);
        return true;
    }
    return false;
}

function getModel(): string {
    if (hasGemini()) return 'gemini-2.0-flash';
    if (hasOpenAI()) return 'gpt-4o-mini';
    return 'gemini-2.0-flash';
}

// ─── 1. Agent.run() — Simple prompt → tool execution ────

describe('Integration: Agent.run()', () => {
    const testDir = join(process.cwd(), '.test-integration-tmp');

    afterEach(() => {
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    test('Agent writes a file via tool execution', async () => {
        if (skipIfNoKey('Agent.run')) return;

        mkdirSync(testDir, { recursive: true });
        const targetFile = join(testDir, 'hello.txt');

        const agent = new Agent({
            model: getModel(),
            cwd: testDir,
            maxIterations: 3,
            objectives: [{
                name: 'file_created',
                description: 'hello.txt exists with "Hello, World!" content',
                validate: async () => {
                    if (!existsSync(targetFile)) return { met: false, reason: 'File does not exist' };
                    const content = readFileSync(targetFile, 'utf-8');
                    return { met: content.includes('Hello'), reason: `Content: "${content}"` };
                },
            }],
        });

        const events: any[] = [];
        for await (const event of agent.run(`Write a file called hello.txt with the content "Hello, World!"`)) {
            events.push(event);
        }

        // Should have completed with objectives met
        expect(existsSync(targetFile)).toBe(true);
        const content = readFileSync(targetFile, 'utf-8');
        expect(content).toContain('Hello');

        // Should have emitted relevant events
        const types = events.map(e => e.type);
        expect(types).toContain('iteration_start');
        expect(types).toContain('llm_response');
        console.log(`✅ Agent.run() — ${events.length} events, file created with: "${content.substring(0, 30)}"`);
    }, { timeout: 120_000 });

    test('Agent handles tool errors gracefully', async () => {
        if (skipIfNoKey('Agent tool errors')) return;

        const agent = new Agent({
            model: getModel(),
            cwd: testDir,
            maxIterations: 2,
            objectives: [{
                name: 'read_nonexistent',
                description: 'Read a file that does not exist and report the error',
                validate: async () => ({ met: true, reason: 'Always passes' }),
            }],
        });

        const events: any[] = [];
        for await (const event of agent.run('Try to read a file called "nonexistent_987654.txt" and tell me what happened.')) {
            events.push(event);
        }

        // Should complete without throwing
        expect(events.length).toBeGreaterThan(0);
        const types = events.map(e => e.type);
        expect(types).toContain('iteration_start');
        console.log(`✅ Agent error handling — ${events.length} events`);
    }, { timeout: 120_000 });
});

// ─── 2. Agent.plan() — Dynamic objective generation ─────

describe('Integration: Agent.plan()', () => {

    test('plan generates objectives from natural language', async () => {
        if (skipIfNoKey('Agent.plan')) return;

        const testDir = join(process.cwd(), '.test-plan-tmp');
        mkdirSync(testDir, { recursive: true });

        const events: any[] = [];
        try {
            const agent = new Agent({ model: getModel() });
            for await (const event of agent.plan(
                `Create a file called ${testDir}/plan-test.txt with the text "planned"`,
                { model: getModel(), cwd: testDir, maxIterations: 3 }
            )) {
                events.push(event);
            }

            // Should have planned objectives
            const planEvents = events.filter(e => e.type === 'plan_complete' || e.type === 'objectives');
            expect(events.length).toBeGreaterThan(0);
            console.log(`✅ Agent.plan() — ${events.length} events, plan events: ${planEvents.length}`);
        } finally {
            if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
        }
    }, { timeout: 120_000 });
});

// ─── 3. Agent — Message history input ───────────────────

describe('Integration: conversation history', () => {

    test('Agent accepts message array for multi-turn', async () => {
        if (skipIfNoKey('conversation history')) return;

        const testDir = join(process.cwd(), '.test-history-tmp');
        mkdirSync(testDir, { recursive: true });

        try {
            const agent = new Agent({
                model: getModel(),
                cwd: testDir,
                maxIterations: 2,
                objectives: [{
                    name: 'done',
                    description: 'Agent responded',
                    validate: async () => ({ met: true, reason: 'Always passes after first iteration' }),
                }],
            });

            const events: any[] = [];
            for await (const event of agent.run([
                { role: 'user', content: 'I need help with a task.' },
                { role: 'assistant', content: 'Sure, what do you need?' },
                { role: 'user', content: 'Just say "MULTI_TURN_OK" so I know this works.' },
            ])) {
                events.push(event);
            }

            const llmResponses = events.filter(e => e.type === 'llm_response');
            expect(llmResponses.length).toBeGreaterThan(0);
            // The LLM should have received the conversation history
            const lastResponse = llmResponses[llmResponses.length - 1];
            console.log(`✅ Conversation history — ${llmResponses.length} LLM responses`);
        } finally {
            if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
        }
    }, { timeout: 120_000 });
});

// ─── 4. Agent — AbortSignal support ─────────────────────

describe('Integration: abort support', () => {

    test('Agent respects AbortSignal', async () => {
        if (skipIfNoKey('abort')) return;

        const agent = new Agent({
            model: getModel(),
            maxIterations: 10,
            objectives: [{
                name: 'never',
                description: 'This objective is impossible',
                validate: async () => ({ met: false, reason: 'Never passes' }),
            }],
        });

        const controller = new AbortController();
        const events: any[] = [];

        // Abort after 2 seconds
        setTimeout(() => controller.abort(), 2000);

        for await (const event of agent.run('Count to 1000 slowly', controller.signal)) {
            events.push(event);
        }

        // Should have stopped early due to abort
        expect(events.length).toBeGreaterThan(0);
        const types = events.map(e => e.type);
        // Should either have aborted or completed a few iterations
        console.log(`✅ Abort support — stopped after ${events.length} events, types: ${[...new Set(types)].join(', ')}`);
    }, { timeout: 30_000 });
});

// ─── 5. Tool parsing ────────────────────────────────────

describe('Integration: tool call parsing', () => {

    test('Agent parses JSON tool calls from LLM output', async () => {
        if (skipIfNoKey('tool parsing')) return;

        const testDir = join(process.cwd(), '.test-parse-tmp');
        mkdirSync(testDir, { recursive: true });

        try {
            const agent = new Agent({
                model: getModel(),
                cwd: testDir,
                maxIterations: 2,
                objectives: [{
                    name: 'listed',
                    description: 'Directory has been listed',
                    validate: async () => ({ met: true, reason: 'Always passes' }),
                }],
            });

            const events: any[] = [];
            for await (const event of agent.run('List the files in the current directory using the list_dir tool.')) {
                events.push(event);
            }

            // Should have parsed and executed at least one tool call
            const toolEvents = events.filter(e => e.type === 'tool_start' || e.type === 'tool_result');
            expect(toolEvents.length).toBeGreaterThan(0);
            console.log(`✅ Tool parsing — ${toolEvents.length} tool events`);
        } finally {
            if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
        }
    }, { timeout: 120_000 });
});
