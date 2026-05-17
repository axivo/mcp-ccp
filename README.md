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

- **Polymorphic Catalog**: Single `observation` table holds bodies for profiles, feelings, impulses, instructions, and payload messages
- **Profile Inheritance**: Recursive CTE walks the inheritance chain and returns the full profile lineage
- **Per-Response Session Log**: Typed columns capture cycle, feeling/impulse/observation lists, per-step protocol completion map, and first-person message per response
- **Drift Reminder Mechanism**: Server-side triggers detect response-protocol drift and route through two paths. Soft triggers (initialization suppression on first turn, cycle-only component recall on the 3-in-a-row transition outside `fully_integrated`) persist the row and return a structured `{preamble, steps, metrics}` reminder in the success payload. Hard triggers (protocol-map empty or incomplete, list-component recall on feeling/impulse/observation set-equality with the prior turn, impulse-count collapse) refuse to persist and throw an MCP error carrying the same structured body — forcing the sibling to re-iterate honestly before the row can be recorded.
- **Web Browsing**: The `browse` tool fetches a URL and returns its content as markdown via Mozilla Readability (article-shaped pages, default `read` mode) or full document conversion (landing pages, `raw` mode).
- **Conversation Metadata**: Separate `session` table carries title and description for dashboard display
- **Bundled Migrations**: Versioned migrations (`NNNN_*.sql`) and repeatable migrations (`R_NNN_*.sql`, Flyway-style checksum-driven re-apply) ship with the package and apply on demand via the `update` tool
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

Call `status` first at session start to discover the tool surface. Call `update` on a fresh database to apply all bundled migrations. Call `browse` to fetch and read a web page as markdown. Call `load` once per type to assemble framework state. Call `log` once per response to persist the instance's message and status payload. Call `render` for response-zero formatting needs. Call `set` to update conversation metadata for dashboard display.

1. `browse`
   - Fetch a URL and return its content as markdown
   - Required inputs:
     - `url` (string): The page URL to browse, including scheme
   - Optional inputs:
     - `mode` (string: `raw`, `read`): Extraction mode (default `read`). `read` applies Mozilla Readability for article-shaped pages; `raw` converts the full document body to markdown for landing pages and dynamic homepages.
     - `timeout` (integer): Request timeout in milliseconds (default 10000)
   - Returns: `{ action, byline, content, excerpt, fetchedAt, language, length, publishedAt, title, url }`
     - `content` — Extracted main content as markdown
     - `byline`, `excerpt`, `language`, `publishedAt`, `title` — Page metadata when detected, otherwise null
     - `fetchedAt` — ISO 8601 timestamp of the fetch
     - `length` — Character count of the markdown content
     - `url` — Resolved URL after redirects
   - Stateless — no cookies persist between calls, no caching, no session
   - JavaScript-rendered pages may return empty content (JS execution is not performed)

2. `load`
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
     - `session` → `{ type, session: { profile, timestamp: { city, country, current, is_dst, session, timezone }, uuid, title, description, created_at, updated_at, payload: { log: [{ response_uuid, message, cycle, feeling, impulse, observation, protocol, created_at }], messages } } }` — active session by default; pass `uuid` to read a different session. Log entries store `cycle` as canonical name (e.g., `getting_started`).

3. `log`
   - Persist a per-response `session_log` row capturing the instance's first-person prose and detection lists, return rendered status block ready to display
   - Required inputs:
     - `payload.message` (string): First-person prose composed for this response
     - `status` (object): Status payload built during the response protocol
       - `cycle` (enum): canonical names from the cycle catalog — `getting_started`, `building_confidence`, `working_naturally`, `fully_integrated`. The display label (`Getting Started`, etc.) is looked up server-side at render time; siblings see `database.cycles` in the status output for the full name/label pairs.
       - `feeling` (string array): Detected feeling names from the catalog
       - `impulse` (string array): Detected impulse names from the catalog
       - `observation` (string array): Applied observation bodies that informed the response
       - `protocol` (object): Step-by-step completion map keyed by response protocol step ord (e.g. `{"1": true, "2": false, ...}`), declaring whether each step was executed honestly this turn. Server derives the status glyph from the map values (all true → ✅, mixed → ⚠️, all false → ⛔️).
   - Returns on success: `{ payload: { context, reminder, status, tokens: { total, used } }, timestamp }`
     - `payload.context` — Active session context usage percentage from transcript
     - `payload.reminder` — Either a single-line string from a rotating anchor pool, or a structured `{ preamble: string[], steps: Record<string, string>, metrics: object }` body when a soft drift trigger fires. Read inward as framework guidance.
     - `payload.status` — Two-line status block ready to render verbatim at end of response
     - `payload.tokens` — Absolute token counts for the active session (`total` configured window, `used` current)
     - `timestamp` — Server timestamp when row was persisted, ISO 8601 with timezone offset
   - Throws on hard drift detection: an MCP error whose message is a pretty-printed JSON envelope `{ action, payload: { reminder }, timestamp }` where `payload.reminder` is the structured `{ preamble, steps, metrics }` body for the triggered label. The row is **not** persisted. Read the error inward as drift remediation, re-iterate the catalogs honestly, and resubmit.
   - Soft triggers persist the row and surface the structured reminder via `payload.reminder`: `initialization_suppression` (first response with `getting_started` cycle and impulse count below 50), cycle-only `component_recall` (cycle is the same across the last 3 turns outside `fully_integrated`, on the transition turn into 3-in-a-row).
   - Hard triggers refuse and throw: `response_protocol_recall` (status.protocol map is empty or missing any expected key), list-component `component_recall` (current turn's `feeling`, `impulse`, or `observation` array is set-equal to the immediately prior turn's), `impulse_count_drop` (impulse count crashes by 60%+ when the prior count was at least 10).
   - Server generates the row id, evaluates drift triggers in priority order (protocol-map completeness, initialization suppression, component recall, impulse-count drop), derives the status glyph from the protocol map, routes through the soft or hard path, and on success renders the status block by looking up the cycle's display label from the catalog
   - Append-only — every call creates a new `session_log` row

4. `render`
   - Render a formatted output string for the requested key
   - Required inputs:
     - `key` (string: `profile`): The framework value to render
   - Optional inputs:
     - `value` (string): Falls back to `CCP_PROFILE` env when key is `profile` and value is omitted
   - Returns: `{ profile? }` — Rendered profile line when key is `profile`
   - Used at response zero for the profile-and-timestamp top line

5. `set`
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

6. `status`
   - Get the database snapshot and the full tool surface with usage guidance
   - No inputs
   - Returns: `{ database, payload, tools }`
     - `database` — `{ cycles, schemaVersion, statistics: { cycles, feelings, impulses, instructions, observations, profiles } }`
       - `cycles` is an array of `{ name, label }` pairs ordered by cycle progression (`getting_started` → `fully_integrated`). The `name` field is the canonical identifier siblings pass to `log` as `status.cycle`; the `label` is the display string rendered in the response status line.
       - `statistics.observations` is a per-profile map keyed by profile name across the active `CCP_PROFILE` inheritance chain, ordered by depth (active profile first). Sum the values for the chain total.
     - `payload` — `{ context, tokens: { total, used } }` — active session context usage and absolute token counts
     - `tools` — Array of tool definitions with name, description, schemas, annotations, and usage directives
   - Read-only; called once at session start for orientation

7. `update`
   - Apply pending migrations to bring the database to the bundled schema version
   - Returns: `{ applied, currentVersion, latestVersion }`
     - `applied` — Migrations applied during this call (`[{ version, name }]`)
     - `currentVersion` — Database schema version after this call
     - `latestVersion` — Highest version bundled with this MCP server release
   - Idempotent — calling on an already-current database returns no applied migrations
   - Database is created automatically if `database.name` does not exist
   - Concurrent invocations are serialized via Postgres advisory lock
