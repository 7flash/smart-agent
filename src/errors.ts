// smart-agent/src/errors.ts
// Structured error hierarchy for tool execution failures

/** Error codes for tool failures — enables programmatic handling by callers */
export type ToolErrorCode =
    | "TIMEOUT"           // Command exceeded toolTimeoutMs
    | "PERMISSION_DENIED" // Safe mode blocked execution
    | "NOT_FOUND"         // File/directory not found
    | "VALIDATION"        // Invalid/missing parameters
    | "EXEC_FAILED"       // Command exited with non-zero
    | "UNKNOWN"           // Catch-all for unexpected errors

/** Base error class for all tool failures */
export class ToolError extends Error {
    readonly code: ToolErrorCode
    readonly tool: string
    readonly params: Record<string, any>

    constructor(code: ToolErrorCode, tool: string, message: string, params: Record<string, any> = {}) {
        super(message)
        this.name = "ToolError"
        this.code = code
        this.tool = tool
        this.params = params
    }
}

/** Command execution exceeded the configured timeout */
export class ToolTimeoutError extends ToolError {
    readonly timeoutMs: number
    readonly partialOutput: string

    constructor(tool: string, timeoutMs: number, partialOutput: string = "", params: Record<string, any> = {}) {
        super("TIMEOUT", tool, `Command timed out after ${Math.round(timeoutMs / 1000)}s`, params)
        this.name = "ToolTimeoutError"
        this.timeoutMs = timeoutMs
        this.partialOutput = partialOutput
    }
}

/** Safe mode prevented tool execution */
export class ToolPermissionError extends ToolError {
    constructor(tool: string, reason: string, params: Record<string, any> = {}) {
        super("PERMISSION_DENIED", tool, reason, params)
        this.name = "ToolPermissionError"
    }
}

/** File or directory not found */
export class ToolNotFoundError extends ToolError {
    readonly path: string

    constructor(tool: string, path: string, params: Record<string, any> = {}) {
        super("NOT_FOUND", tool, `File not found: ${path}`, params)
        this.name = "ToolNotFoundError"
        this.path = path
    }
}

/** Invalid or missing tool parameters */
export class ToolValidationError extends ToolError {
    constructor(tool: string, message: string, params: Record<string, any> = {}) {
        super("VALIDATION", tool, message, params)
        this.name = "ToolValidationError"
    }
}

/**
 * Classify a ToolResult error string into a ToolErrorCode.
 * Used by callers who want to inspect error types without catching exceptions.
 */
export function classifyError(error: string): ToolErrorCode {
    if (error.includes("timed out")) return "TIMEOUT"
    if (error.includes("Safe Mode") || error.includes("rejected by user") || error.includes("not allowed")) return "PERMISSION_DENIED"
    if (error.includes("not found") || error.includes("File not found")) return "NOT_FOUND"
    if (error.includes("is required") || error.includes("must be unique")) return "VALIDATION"
    if (error.includes("Exit code")) return "EXEC_FAILED"
    return "UNKNOWN"
}
