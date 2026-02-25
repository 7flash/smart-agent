---
name: git
description: Git version control — staging, committing, branching, and history
---

# Git

## Commands

### status
Show working tree status.
```bash
git status
```

### add
Stage files for commit.
```bash
git add {path}
```
- **path**: File or directory to stage (use `.` for all)

### commit
Create a commit with a message.
```bash
git commit -m "{message}"
```
- **message**: Commit message

### log
Show recent commit history.
```bash
git log --oneline -n {count}
```
- **count**: Number of commits to show (default: 10)

### diff
Show changes in working directory.
```bash
git diff {path}
```
- **path**: Optional file path to diff

### branch
List or create branches.
```bash
git branch {name}
```
- **name**: Branch name (omit to list all)

### checkout
Switch branches or restore files.
```bash
git checkout {target}
```
- **target**: Branch name or file path
