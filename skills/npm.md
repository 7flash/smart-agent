---
name: npm
description: npm package manager — install, run scripts, publish
---

# npm

## Commands

### install
Install all dependencies.
```bash
npm install
```

### add
Add a package.
```bash
npm install {package}
```
- **package**: Package name (use `--save-dev` for devDependency)

### run
Run a package.json script.
```bash
npm run {script}
```
- **script**: Script name from package.json

### test
Run tests.
```bash
npm test
```

### publish
Publish package to npm registry.
```bash
npm publish {flags}
```
- **flags**: Optional flags like `--access public`

### init
Initialize a new package.json.
```bash
npm init -y
```
