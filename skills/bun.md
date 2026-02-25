---
name: bun
description: Bun runtime — run scripts, install packages, test, and build
---

# Bun Runtime

## Commands

### run
Run a TypeScript/JavaScript file.
```bash
bun run {file}
```
- **file**: Script file to run

### test
Run tests.
```bash
bun test {pattern}
```
- **pattern**: Optional test file glob pattern

### install
Install dependencies from package.json.
```bash
bun install
```

### add
Add a dependency.
```bash
bun add {package}
```
- **package**: Package name (use `-d` for devDependency)

### init
Initialize a new project.
```bash
bun init
```

### build
Bundle a project.
```bash
bun build {entrypoint} --outdir {dir}
```
- **entrypoint**: Entry file to bundle
- **dir**: Output directory
