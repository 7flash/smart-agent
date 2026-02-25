---
name: memory
description: Persist and retrieve structured data via the geeksy Memory API. Use this to store research findings, contacts, config, notes, or any key-value data that should survive between agent sessions.
---

# Memory API

Keys use dot-notation for grouping:
- `research.ai-trends` → groups under RESEARCH
- `contacts.john` → groups under CONTACTS
- `config.telegram.apiKey` → groups under CONFIG

Values can be plain strings or JSON-serialized objects.

**Environment**: `STATE_URL` — The base URL for the Memory API (injected by scheduler)

## Commands

### get
Read a single value by key.
```bash
curl "$STATE_URL?agentId={agentId}&key={key}"
```
- **agentId**: Your agent ID (number)
- **key**: Dot-notation key, e.g. `research.ai-trends`

**Example:**
```bash
curl "$STATE_URL?agentId=1&key=research.ai-trends"
# → { "agentId": 1, "key": "research.ai-trends", "value": "{...}" }
```

### list
List all memory entries for your agent.
```bash
curl "$STATE_URL?agentId={agentId}"
```
- **agentId**: Your agent ID (number)

**Example:**
```bash
curl "$STATE_URL?agentId=1"
# → [{ "id": 1, "agentId": 1, "key": "research.ai-trends", "value": "{...}" }, ...]
```

### set
Store or update a value (upserts — creates if new, updates if exists).
```bash
curl -X POST "$STATE_URL" \
  -H "Content-Type: application/json" \
  -d '{"agentId": {agentId}, "key": "{key}", "value": "{value}"}'
```
- **agentId**: Your agent ID (number)
- **key**: Dot-notation key
- **value**: String value — use `JSON.stringify` for objects

**Example:**
```bash
curl -X POST "$STATE_URL" \
  -H "Content-Type: application/json" \
  -d '{"agentId": 1, "key": "research.ai-trends", "value": "{\"topic\": \"multimodal agents\", \"findings\": [\"GPT-5 rumored\", \"Claude 4 released\"], \"date\": \"2026-02-25\"}"}'
```

### delete
Remove a memory entry.
```bash
curl -X DELETE "$STATE_URL?agentId={agentId}&key={key}"
```
- **agentId**: Your agent ID (number)
- **key**: Key to delete

## Best Practices

- Use descriptive, hierarchical keys: `research.topic-name`, `contacts.person-name`
- Store JSON objects for structured data, not plain text
- Always include a date field in stored objects for temporal context
- Read existing memory before writing to avoid overwriting important data
- Group related data under a common prefix for easy browsing in the Memory tab
