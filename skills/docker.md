---
name: docker
description: Docker container management — build, run, and manage containers
---

# Docker

## Commands

### build
Build a Docker image from a Dockerfile.
```bash
docker build -t {tag} {context}
```
- **tag**: Image tag (e.g. `myapp:latest`)
- **context**: Build context directory (default: `.`)

### run
Run a container from an image.
```bash
docker run {flags} {image} {cmd}
```
- **image**: Image to run
- **flags**: Optional flags (`-d` for detached, `-p` for port mapping, `--name` for naming)
- **cmd**: Optional command to run in container

### ps
List running containers.
```bash
docker ps {flags}
```
- **flags**: Use `-a` to show all containers

### stop
Stop a running container.
```bash
docker stop {container}
```
- **container**: Container name or ID

### logs
View container logs.
```bash
docker logs {flags} {container}
```
- **container**: Container name or ID
- **flags**: Use `-f` to follow, `--tail N` to limit

### compose
Docker Compose operations.
```bash
docker compose {subcommand}
```
- **subcommand**: `up -d`, `down`, `logs`, `ps`, etc.
