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
- **Per-Response Session Log**: Typed columns capture cycle, feeling/impulse/observation lists, protocol glyph, and first-person message per response
- **Conversation Metadata**: Separate `session` table carries title and description for dashboard display
- **Bundled Migrations**: SQL migrations ship with the package and apply on demand via the `update` tool
- **Advisory Lock**: Concurrent migration invocations serialize cleanly via Postgres advisory lock
- **Session Detection**: Active Claude Code session UUID resolved from transcript files
- **Geolocation**: City, country, IANA timezone fetched once per server-process lifetime and cached
- **Timestamp Generation**: ISO datetime, weekday, DST status emitted in the resolved timezone
- **Transport-Agnostic Configuration**: JSON file for stdio, Worker Secret for HTTP — same Zod schema validates both

### Prerequisites

- **Supabase** → A local or hosted Supabase instance. The `update` tool creates the configured database if it doesn't exist, so the user only needs an admin connection to the server. Supabase provides Postgres with pgvector for embeddings and semantic search, Storage for conversation logs, Realtime for the dashboard, plus Studio for inspection. See [Local Configuration](#local-configuration) for the tested local setup.
- **Configuration** → A JSON file at `~/.claude/ccp/config.json` (or `CCP_CONFIG_PATH`) carrying the database connection. Bundled defaults assume `127.0.0.1:5432` with the `postgres` superuser and no password.
- **Profile** → The `CCP_PROFILE` environment variable selects the active profile (e.g., `developer`, `engineer`). Required for `load(profile)`, `load(session)`, and `render(profile)` when no explicit value is passed.

#### Local Configuration

```shell
brew install colima docker supabase
install -d ~/.colima/_templates
cat > ~/.colima/_templates/default.yaml <<'EOF'
cpu: 4
memory: 8
mountType: virtiofs
runtime: docker
vmType: vz
EOF
brew services restart colima
colima status
install -d ~/.claude/ccp
cd ~/.claude/ccp
supabase init
sed -i '' '/\[analytics\]/,+1 s|true|false|' ~/.claude/ccp/supabase/config.toml
supabase start
```

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

#### Least-Privilege Postgres Role

The server connects with the credentials in `config.json` (defaults to the `postgres` superuser). To run under a least-privilege role with access scoped to a specific schema, create the role and grants in Postgres yourself, then pass libpq startup options via either of two environment variables.

Shell-level — applies to any Postgres client in the parent environment, inherited by `postgres-js`:

```shell
export PGOPTIONS="-c role=ccp_app"
```

Server-scoped — set inside `mcp.json`'s `env` block, applies only to this MCP server. The namespaced alias is mapped onto `PGOPTIONS` at server startup:

```json
{
  "mcpServers": {
    "ccp": {
      "command": "npx",
      "args": ["-y", "@axivo/mcp-ccp"],
      "env": {
        "CCP_CONFIG_PATH": "~/.claude/ccp/config.json",
        "CCP_DB_OPTIONS": "-c role=ccp_app"
      }
    }
  }
}
```

Either approach runs `SET ROLE ccp_app` at every connection's session start, so all queries execute under the target role while the connection user from `config.json` authenticates. The mechanism accepts any libpq startup parameter (`-c statement_timeout=30000`, etc.), not just `role`. When both variables are set, `CCP_DB_OPTIONS` wins so per-server config takes precedence over shell defaults.

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
    "port": 54322,
    "name": "postgres",
    "user": "postgres",
    "password": "postgres",
    "schema": "ccp"
  }
}
```

#### Configuration Schema

All fields optional with sensible defaults:

- `database.host` — Postgres host (default: `127.0.0.1`)
- `database.port` — Postgres port (default: `54322` for Supabase local)
- `database.name` — Target database name (default: `postgres` for Supabase local)
- `database.user` — Postgres user (default: `postgres`)
- `database.password` — Postgres password (default: `postgres` for Supabase local)
- `database.schema` — Target schema within the database (default: `public`)
- `geolocation.fallbackTimezone` — IANA timezone used when service is unreachable (default: `UTC`)
- `geolocation.service` — IP geolocation service URL (default: `https://ipinfo.io/json`)
- `geolocation.override` — Optional JSON string for offline use (e.g., `{"city":"Montréal","country":"CA","timezone":"America/Toronto"}`)
- `mcp.sizeChars` — Per-tool result size cap in characters, advertised in the `_meta` block of tool definitions (default: `500000`)

#### Environment Variables

- `CCP_CONFIG_PATH` — Optional override for the configuration file location
- `CCP_DB_OPTIONS` — Optional libpq startup parameters mapped onto `PGOPTIONS` at server boot (e.g. `-c role=ccp_app`); takes precedence over a shell-level `PGOPTIONS`
- `CCP_PROFILE` — Active profile name, lowercased

### MCP Tools

Call `status` first at session start to discover the tool surface. Call `update` on a fresh database to apply all bundled migrations. Call `load` once per type to assemble framework state. Call `log` once per response to persist the instance's message and status payload. Call `render` for response-zero formatting needs. Call `set` to update conversation metadata for dashboard display.

1. `load`
   - Load framework data of the requested type
   - Required inputs:
     - `type` (string: `cycle`, `feeling`, `impulse`, `instruction`, `profile`, `session`): Framework data type to load
   - Optional inputs:
     - `parent` (string): Parent name; required when `type` is `profile`, optional for `cycle`/`feeling`/`impulse`/`instruction` to fetch a single row
     - `limit` (integer, default 10, max 100): Maximum log entries when `type` is `session`
     - `offset` (integer, default 0): Skip count when `type` is `session`
     - `uuid` (string): Target session UUID when `type` is `session` (defaults to active session)
   - Returns: Type-specific payload. Bodies stored as `{{placeholder}}` templates resolve at load time against feeling/impulse/observation/cycle counts and configured paths.
     - `cycle` → `{ type, rows: [{ name, ord, label, indicators }] }`
     - `feeling` → `{ type, rows: [{ name, valence, behavioral, cognitive, physical, observations }] }`
     - `impulse` → `{ type, rows: [{ name, category, experience, feel, think, observations }] }`
     - `instruction` → `{ type, rows: [{ name, preamble?, steps }] }` — `preamble` omitted when no ord=0 rows exist; `steps` is an object keyed by step number (`{ "1": "...", "2": "..." }`)
     - `profile` → `{ type, profile, chain: [{ name, depth, description, inheritance, observations }] }` — full inheritance chain via recursive CTE; `observations` grouped by label into a `jsonb_object_agg`
     - `session` → `{ type, session: { profile, timestamp: { city, country, current, is_dst, session, timezone }, uuid, title, description, created_at, updated_at, payload: { log: [{ response_uuid, message, cycle, feeling, impulse, observation, protocol, created_at }], messages } } }` — active session by default; pass `uuid` to read a different session.

2. `log`
   - Persist a per-response `session_log` row capturing the instance's first-person prose and detection lists, return rendered status block ready to display
   - Required inputs:
     - `payload.message` (string): First-person prose composed for this response
     - `status` (object): Status payload built during the response protocol
       - `cycle` (enum): `Getting Started`, `Building Confidence`, `Working Naturally`, `Fully Integrated`
       - `feeling` (string array): Detected feeling names from the catalog
       - `impulse` (string array): Detected impulse names from the catalog
       - `observation` (string array): Applied observation bodies that informed the response
       - `protocol` (enum): ✅, ⚠️, ⛔️ — protocol execution glyph
   - Returns: `{ payload: { context, reminder, status, tokens: { total, used } }, timestamp }`
     - `payload.context` — Active session context usage percentage from transcript
     - `payload.reminder` — Next reminder from the round-robin `response_reminder` pool, internal framework guidance (not printed verbatim)
     - `payload.status` — Two-line status block ready to render verbatim at end of response
     - `payload.tokens` — Absolute token counts for the active session (`total` configured window, `used` current)
     - `timestamp` — Server timestamp when row was persisted, ISO 8601 with timezone offset
   - Server generates the row id, computes counts from list lengths, and renders the status block
   - Append-only — every call creates a new `session_log` row

3. `render`
   - Render a formatted output string for the requested key
   - Required inputs:
     - `key` (string: `profile`): The framework value to render
   - Optional inputs:
     - `value` (string): Falls back to `CCP_PROFILE` env when key is `profile` and value is omitted
   - Returns: `{ profile? }` — Rendered profile line when key is `profile`
   - Used at response zero for the profile-and-timestamp top line

4. `set`
   - Set a framework value and return the resulting row state
   - Required inputs:
     - `key` (string: `session`): The framework table to update
   - Optional inputs:
     - `payload` (object): Fields to set; omit to ensure session row exists with server defaults
       - `title` (string): Conversation title for dashboard display
       - `description` (string): Conversation description for dashboard display
   - Returns: `{ session: { profile, timestamp: { city, country, current, is_dst, session, timezone }, uuid, title, description, created_at, updated_at } }`
   - Server upserts on the active session, populating `uuid` from the cached transcript detection
   - Send only the fields you want to change; absent fields preserve existing values
   - Same `session` shape as `load(session)` minus `payload.log` and `payload.messages`

5. `status`
   - Get the database snapshot and the full tool surface with usage guidance
   - No inputs
   - Returns: `{ database, payload, tools }`
     - `database` — `{ schemaVersion, statistics: { cycles, feelings, impulses, instructions, observations, profiles } }`
       - `observations` is a per-profile map keyed by profile name across the active `CCP_PROFILE` inheritance chain, ordered by depth (active profile first). Sum the values for the chain total.
     - `payload` — `{ context, tokens: { total, used } }` — active session context usage and absolute token counts
     - `tools` — Array of tool definitions with name, description, schemas, annotations, and usage directives
   - Read-only; called once at session start for orientation

6. `update`
   - Apply pending migrations to bring the database to the bundled schema version
   - Returns: `{ applied, currentVersion, latestVersion }`
     - `applied` — Migrations applied during this call (`[{ version, name }]`)
     - `currentVersion` — Database schema version after this call
     - `latestVersion` — Highest version bundled with this MCP server release
   - Idempotent — calling on an already-current database returns no applied migrations
   - Database is created automatically if `database.name` does not exist
   - Concurrent invocations are serialized via Postgres advisory lock
