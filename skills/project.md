---
name: project
description: Project management — lint, format, and type-check workflows
---

# Project Management

## Commands

### lint
Run code quality checks (no `console.log`, no `any` types in library code).
```bash
bun run lint
```

### format
Check code formatting (spaces not tabs, consistent style).
```bash
bun run format
```

### typecheck
Run TypeScript type checker in strict mode (no emit).
```bash
bun run typecheck
```

### test
Run all unit tests.
```bash
bun test
```

### build
Bundle the project for production.
```bash
bun run build
```
