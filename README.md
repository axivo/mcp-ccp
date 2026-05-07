# CCP MCP Server

[![License: BSD 3-Clause](https://img.shields.io/badge/License-BSD%203--Clause-blue.svg?style=flat&logo=opensourceinitiative&logoColor=white)](https://github.com/axivo/mcp-ccp/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/@axivo/mcp-ccp.svg?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@axivo/mcp-ccp)
[![Socket](https://badge.socket.dev/npm/package/@axivo/mcp-ccp)](https://socket.dev/npm/package/@axivo/mcp-ccp)
[![Node.js](https://img.shields.io/badge/Node.js->=24.0.0-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript->=6.0.0-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Postgres](https://img.shields.io/badge/Postgres->=15-4169E1?style=flat&logo=postgresql&logoColor=white)](https://www.postgresql.org/)

A MCP (Model Context Protocol) server for the [Claude Collaboration Platform](https://axivo.com/claude) framework.

> [!NOTE]
>
> The collaboration platform is not affiliated with, endorsed by, or sponsored by Anthropic. "Anthropic" and "Claude" are trademarks of Anthropic, PBC. All rights belong to their respective owners.

### Features

- **Polymorphic Catalog**: Single `observation` table holds bodies for profiles, feelings, impulses, and instructions
- **Profile Inheritance**: Recursive CTE walks the inheritance chain and returns the full profile lineage
- **Per-Response Session Log**: JSONB status column captures cycle, feelings, impulses, observations counts per response
- **Bundled Migrations**: SQL migrations ship with the package and apply on demand via the `update` tool
- **Advisory Lock**: Concurrent migration invocations serialize cleanly via Postgres advisory lock
- **Session Detection**: Active Claude Code session UUID resolved from transcript files
- **Geolocation**: City, country, IANA timezone fetched once per server-process lifetime and cached
- **Timestamp Generation**: ISO datetime, weekday, DST status emitted in the resolved timezone
- **Transport-Agnostic Configuration**: JSON file for stdio, Worker Secret for HTTP — same Zod schema validates both

### Prerequisites

- **Postgres** → A reachable Postgres instance (local, Supabase, or any Postgres). The `update` tool creates the configured database if it doesn't exist, so the user only needs an admin connection to the server.
- **Configuration** → A JSON file at `~/.claude/ccp/config.json` (or `CCP_CONFIG_PATH`) carrying the database connection. Bundled defaults assume `127.0.0.1:5432` with the `postgres` superuser and no password.
- **Profile** → The `CCP_PROFILE` environment variable selects the active profile (e.g., `developer`, `engineer`). Required for `load(profile)` and `load(session)`.

### MCP Server Configuration

Add to `mcp.json` servers configuration:

```json
{
  "mcpServers": {
    "ccp": {
      "command": "npx",
      "args": ["-y", "@axivo/mcp-ccp"],
      "env": {
        "CCP_CONFIG_PATH": "~/.claude/ccp/config.json"
      }
    }
  }
}
```

#### Configuration File

The server loads connection settings from a JSON file. Path resolution order:

1. `CCP_CONFIG_PATH` env var (explicit override)
2. `~/.claude/ccp/config.json` (default location)
3. Bundled defaults if no file exists

Example `~/.claude/ccp/config.json`:

```json
{
  "database": {
    "host": "127.0.0.1",
    "port": 5432,
    "name": "ccp",
    "user": "postgres",
    "password": ""
  }
}
```

#### Configuration Schema

All fields optional with sensible defaults:

- `database.host` — Postgres host (default: `127.0.0.1`)
- `database.port` — Postgres port (default: `5432`)
- `database.name` — Target database name (default: `ccp`)
- `database.user` — Postgres user (default: `postgres`)
- `database.password` — Postgres password (default: empty)
- `geolocation.fallbackTimezone` — IANA timezone used when service is unreachable (default: `UTC`)
- `geolocation.service` — IP geolocation service URL (default: `https://ipinfo.io/json`)
- `geolocation.override` — Optional JSON string for offline use (e.g., `{"city":"Montréal","country":"CA","timezone":"America/Toronto"}`)

#### Environment Variables

- `CCP_CONFIG_PATH` — Optional override for the configuration file location
- `CCP_PROFILE` — Active profile name, lowercased at every read

### MCP Tools

Call `update` first on a fresh database to apply all bundled migrations. Call `load` once per type at session start to assemble framework state. Call `log_response` once per response to persist the sibling's message and status payload.

1. `load`
   - Load framework data of the requested type
   - Required inputs:
     - `type` (string: `cycle`, `feeling`, `impulse`, `instruction`, `profile`, `session`): Framework data type to load
   - Optional inputs:
     - `parent` (string): Parent name; required when `type` is `profile`, optional for `cycle`/`feeling`/`impulse`/`instruction` to fetch a single row
   - Returns: Type-specific payload
     - `cycle` → `{ type, rows: [{ name, ord, label, indicators }] }`
     - `feeling` → `{ type, rows: [{ name, valence, behavioral, cognitive, physical, observations }] }`
     - `impulse` → `{ type, rows: [{ name, category, experience, feel, think, observations }] }`
     - `instruction` → `{ type, rows: [{ name, preamble?, steps }] }` — `preamble` omitted when no ord=0 rows exist
     - `profile` → `{ type, profile, chain, framework, session_uuid, timestamp }` — full inheritance chain via recursive CTE plus session envelope
     - `session` → `{ type, framework, session_uuid, timestamp }` — session envelope only

2. `log_response`
   - Persist a per-response session row capturing the sibling's first-person prose and status payload
   - Required inputs:
     - `id` (string): RFC4122 v4 UUID generated by the sibling for this row
     - `message` (string): First-person prose composed for this response
     - `status` (object): Status payload built during the response protocol (cycle, feelings, impulses, observations)
   - Returns: `{ id }` — Stored row id, returned to confirm persistence
   - Append-only by convention; `on conflict (id) do update` for retry idempotency

3. `update`
   - Apply pending migrations to bring the database to the bundled schema version
   - Returns: `{ applied, currentVersion, latestVersion }`
     - `applied` — Migrations applied during this call (`[{ version, name }]`)
     - `currentVersion` — Database schema version after this call
     - `latestVersion` — Highest version bundled with this MCP server release
   - Idempotent — calling on an already-current database returns no applied migrations
   - Database is created automatically if `database.name` does not exist
   - Concurrent invocations are serialized via Postgres advisory lock
