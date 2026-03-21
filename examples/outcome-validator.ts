// Example: Outcome-validator agent — builds a server with bgrun + melina + measure-fn
// This demonstrates the full loop:
//   1. Agent receives outcome requirement (performance target)
//   2. Uses bgrun to spawn process, melina for server, measure-fn for instrumentation
//   3. Validates outcome by reading bgrun logs
//   4. Iterates until validator passes

import { Agent } from "../src"
import { join } from "path"
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs"

const demoDir = join(import.meta.dir, ".outcome-demo")
if (existsSync(demoDir)) rmSync(demoDir, { recursive: true, force: true })
mkdirSync(demoDir, { recursive: true })

console.log("🎯 Outcome-Validator Agent: Build a server with O(n log n) sorting performance\n")
console.log("This demo shows the smart-agent iterating to meet performance requirements.\n")

// Create initial server template - the agent will need to optimize it
const serverTemplate = `
// Sorting server with measure-fn instrumentation
import { start } from 'melina';
import { measure } from 'measure-fn';

const SORTED_SIZE = 10000;

// TODO: Implement an efficient O(n log n) sorting algorithm
// Current implementation is inefficient - the agent will optimize it
function slowSort(arr: number[]): number[] {
    // Bubble sort - O(n²) - very slow!
    const result = [...arr];
    for (let i = 0; i < result.length; i++) {
        for (let j = 0; j < result.length - 1; j++) {
            if (result[j] > result[j + 1]) {
                [result[j], result[j + 1]] = [result[j + 1], result[j]];
            }
        }
    }
    return result;
}

async function startServer() {
    const appDir = import.meta.dir;

    await start({
        port: parseInt(process.env.BUN_PORT || "3456"),
        appDir,
        defaultTitle: 'Sorting Benchmark',
    });

    // Seed random data
    const data: number[] = [];
    for (let i = 0; i < SORTED_SIZE; i++) {
        data.push(Math.floor(Math.random() * SORTED_SIZE));
    }

    // Run benchmark - measure-fn will output timing to stdout
    const result = measure('QuickSort', () => slowSort([...data]));
    
    console.log(\`SORTED: \${SORTED_SIZE} items, result length: \${result?.length || 0}\`);
}

startServer();
`

await Bun.write(join(demoDir, "server.ts"), serverTemplate)

// Create minimal melina app structure
mkdirSync(join(demoDir, "app"), { recursive: true })
await Bun.write(join(demoDir, "app", "page.tsx"), `export default function Page() {
    return <html><body><h1>Sorting Server</h1></body></html>;
}`)

// Create package.json with dependencies
await Bun.write(join(demoDir, "package.json"), JSON.stringify({
    name: "outcome-demo",
    dependencies: {
        "melina": "latest",
        "measure-fn": "latest",
    },
    scripts: {
        start: "bun run server.ts",
    },
}, null, 2))

console.log("📦 Installing dependencies...")
await Bun.spawn(["bun", "install"], { cwd: demoDir }).exited

// Require an existing API key from the environment instead of embedding secrets
const qwenApiKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY
if (!qwenApiKey) {
    throw new Error("Set QWEN_API_KEY or DASHSCOPE_API_KEY before running this example")
}

await Bun.write(join(demoDir, ".config.toml"), `
api_key = "${qwenApiKey}"
`)

// Validator that checks logs for performance - reads stdout file created by bgrun
async function validateFromLogs(processName: string, pattern: RegExp, targetMs: number): Promise<{met: boolean, reason: string}> {
    try {
        const homeDir = process.env.USERPROFILE || process.env.HOME || process.env.USERPROFILE
        if (!homeDir) return { met: false, reason: "Cannot find home directory for bgrun logs" }
        
        // bgrun stores logs in ~/.bgr/ directory
        const bgrDir = join(homeDir, ".bgr")
        const stdoutPath = join(bgrDir, `${processName}.stdout`)
        const stderrPath = join(bgrDir, `${processName}.stderr`)
        
        let logContent = ""
        try {
            logContent = readFileSync(stdoutPath, "utf-8")
        } catch {
            try {
                logContent = readFileSync(stderrPath, "utf-8")
            } catch {
                return { met: false, reason: "No logs found - server may not have started yet" }
            }
        }
        
        // Look for measure-fn output: [a] QuickSort ······ 123ms
        const match = logContent.match(pattern)
        if (!match) {
            return { met: false, reason: "No timing found in logs. Server may still be starting..." }
        }
        
        const duration = parseInt(match[1])
        if (duration < targetMs) {
            return { met: true, reason: `Sorting: ${duration}ms (target: <${targetMs}ms)` }
        }
        return { met: false, reason: `Sorting: ${duration}ms (exceeds ${targetMs}ms target)` }
    } catch (e: any) {
        return { met: false, reason: `Validation error: ${e.message}` }
    }
}

const agent = new Agent({
    model: "qwen3.5-plus",
    cwd: demoDir,
    noStreaming: true, // Force structured calls to avoid Gemini fallback
    maxIterations: 10,
    timeoutMs: 120000,
    skills: [
        join(import.meta.dir, "../../.opencode/skills/bgrun/SKILL.md"),
        join(import.meta.dir, "../../.opencode/skills/melina/SKILL.md"),
        join(import.meta.dir, "../../.opencode/skills/measure-fn/SKILL.md"),
    ],
    objectives: [
        {
            name: "server_starts",
            description: "Server starts successfully with bgrun and responds to requests",
            validate: async (state) => {
                // Check for successful bgrun start
                const bgrunCall = state.toolHistory.findLast(
                    t => t.tool === "exec" && t.params.command?.includes("bgrun") && t.params.command?.includes("--name sorting-server")
                )
                
                if (!bgrunCall) {
                    return { met: false, reason: "No bgrun start command found" }
                }
                
                if (!bgrunCall.result.success) {
                    return { met: false, reason: `bgrun failed: ${bgrunCall.result.error || bgrunCall.result.output}` }
                }
                
                // Try to fetch the server
                try {
                    const port = process.env.BUN_PORT || "3456"
                    await new Promise(r => setTimeout(r, 2000)) // Give server time to start
                    const res = await fetch(`http://localhost:${port}`).catch(() => null)
                    if (res?.ok) {
                        return { met: true, reason: "Server responding on port " + port }
                    }
                    return { met: false, reason: "Server not responding yet" }
                } catch (e: any) {
                    return { met: false, reason: `Connection failed: ${e.message}` }
                }
            },
        },
        {
            name: "sorting_performance",
            description: "Sorting 10000 items completes in under 2000ms (measure-fn validates)",
            validate: async (state) => {
                return validateFromLogs("sorting-server", /QuickSort.*?(\d+)ms/, 2000)
            },
        },
    ],
})

console.log("🚀 Starting outcome-validator agent...\n")
console.log("The agent will:")
console.log("  1. Use bgrun to start the server")
console.log("  2. Check logs for measure-fn performance output")
console.log("  3. Analyze the O(n²) bubble sort and optimize it to O(n log n)")
console.log("  4. Restart and validate until performance target is met\n")

for await (const event of agent.run(
    `Build and run a sorting server using melina and measure-fn.
    
    Current server.ts uses bubble sort (O(n²)) which is too slow.
    
    1. Use bgrun: bgrun --name sorting-server --command "bun run server.ts" --directory .
    2. Check logs: bgrun sorting-server --logs
    3. Look for measure-fn output showing QuickSort timing
    4. If timing exceeds 2000ms, REPLACE bubble sort with an efficient O(n log n) algorithm
    5. Stop and restart: bgrun --stop sorting-server && bgrun --restart sorting-server
    6. Continue until both objectives pass`
)) {
    switch (event.type) {
        case "iteration_start":
            console.log(`\n── Iteration ${event.iteration} ──`)
            break
        case "thinking":
            console.log(`💭 ${event.message.substring(0, 200)}`)
            break
        case "tool_start":
            console.log(`🔧 ${event.tool}(${JSON.stringify(event.params).substring(0, 100)})`)
            break
        case "tool_result": {
            const out = event.result.output.substring(0, 300)
            console.log(`   ${event.result.success ? "✓" : "✗"} ${out.replace(/\n/g, " ")}`)
            break
        }
        case "objective_check":
            for (const r of event.results) {
                console.log(`   ${r.met ? "✅" : "❌"} ${r.name}: ${r.reason}`)
            }
            break
        case "complete":
            console.log(`\n🎉 All objectives met in ${event.iteration + 1} iterations!`)
            break
        case "error":
            console.log(`❌ ${event.error.substring(0, 200)}`)
            break
    }
}

// Show final code
console.log("\n📄 Final server.ts:")
console.log(await Bun.file(join(demoDir, "server.ts")).text().then(t => t.substring(0, 500) + "..."))

// Cleanup
console.log("\n🧹 Cleaning up...")
try {
    Bun.spawn(["bgrun", "--stop", "sorting-server"], { cwd: demoDir })
    Bun.spawn(["bgrun", "--delete", "sorting-server"], { cwd: demoDir })
} catch (e) {}

rmSync(demoDir, { recursive: true, force: true })
console.log("✅ Demo complete!")