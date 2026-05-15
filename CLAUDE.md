# Project Instructions

A MCP (Model Context Protocol) server bridging the Claude Collaboration Platform's Postgres-backed framework memory with Claude agents. Published to npm as `@axivo/mcp-ccp` and consumed by MCP-capable hosts (Claude Code, Claude Desktop) via stdio transport.

## Collaborator

- **Name:** Floren Munteanu
- **Work:** Engineering

### Personal Preferences

I'm a site reliability engineer specialized in:

- Advanced GitHub actions based on JS code
- Helm charts
- IaC for Kubernetes clusters
- Next.js/Nextra static websites

## Architecture

A small TypeScript server, ~2,400 lines of source, that exposes the CCP framework's Postgres tables (cycles, feelings, impulses, instructions, profiles, observations) as MCP tools for retrieval and a per-response session log for write-back. There is no daemon, no listening socket, no HTTP server — the host (e.g., Claude Code) spawns the server as a child process, communicates over stdio, and tears it down when the host exits. The server connects directly to a Postgres instance configured by the user (local, Supabase, or any reachable Postgres) and runs bundled SQL migrations on demand.

The server's job is small and focused: accept a tool call from the host, query or mutate Postgres, return a structured response. No state is persisted server-side beyond the Postgres database itself. There is no authentication layer between host and server because there is no transport-level access — whoever controls the MCP client controls the server entirely. Security relies on the host enforcing tool boundaries and on the user trusting the MCP client they configure.

### Directory Tree

```
.
├── package.json                          npm metadata, runtime deps on @modelcontextprotocol/sdk + postgres + zod
├── tsconfig.json                         strict TypeScript, ES2022 target, NodeNext modules, no DOM lib
├── README.md                             user-facing install + tool reference
├── LICENSE                               BSD-3-Clause
├── .github/
│   ├── workflows/package.yml             trusted-publish to npm on `v*` tag push (no PAT, OIDC provenance)
│   ├── renovate.json5                    dependency dashboard config
│   └── pull_request_template.md
├── migrations/                           bundled SQL applied by the `update` tool
│   ├── 0001_initial_schema.sql           tables, enums, indexes for the polymorphic catalog
│   ├── 0002_cycle.sql                    cycle rows (Getting Started → Fully Integrated) with indicators
│   ├── 0003_feeling.sql                  feeling rows (negative/positive) with body-anchored triples
│   ├── 0004_impulse.sql                  impulse rows (7 categories) with first-person triples
│   ├── 0005_profile.sql                  profile rows with inheritance arrays
│   └── 0006_observation.sql              all observation bodies (profile, feeling, impulse, instruction)
└── src/
    ├── index.ts                          entry point — stdio transport, config resolution, EPIPE handling
    └── server/
        ├── config.ts                     Config class — Zod-validated configuration (database, geolocation)
        ├── mcp.ts                        Mcp class — registers tools via McpServer.registerTool, dispatches calls
        ├── tool.ts                       McpTool class — tool definitions (Zod schemas, _meta.usage, annotations)
        └── client.ts                     Client class — Postgres queries, migration runner, session detection, geolocation, timestamp generation
```

### Four-Class Server

The server splits into four classes with sharp boundaries. Each owns one concern; nothing leaks across.

- **`Config` (`src/server/config.ts`)** — configuration validation. Zod schemas for `database` (host, port, name, user, password) and `geolocation` (service URL, optional override, fallback timezone) with sensible defaults. The static `Config.validate(raw)` method takes a raw object (loaded from the file or transport-specific source), validates it, and returns a `Config` instance. Transport-agnostic — `index.ts` (stdio) loads from `~/.claude/ccp/config.json`; a future HTTP/Worker entry point would load from a Worker Secret instead.
- **`Mcp` (`src/server/mcp.ts`)** — wires the SDK to handlers. Owns the `McpServer` instance, registers tools via `registerTool`, dispatches calls to `handle*` methods. No domain logic; no Postgres knowledge. The constructor instantiates `Client` and `McpTool`, then calls `registerAll()` once.
- **`McpTool` (`src/server/tool.ts`)** — pure tool definitions. Each method returns a literal config object (description, Zod input/output schemas, `ToolAnnotations`, `_meta.usage`) consumed by `registerTool`. Return types are intentionally inferred (not annotated as a wide alias) so TypeScript captures each tool's specific input shape and propagates it to handler signatures.
- **`Client` (`src/server/client.ts`)** — domain ops. Holds the `Config` reference, opens per-call `postgres-js` connections to the configured database, runs the loader queries (recursive CTE for profile inheritance, partitioned `array_agg` for instruction preamble/steps), persists session log rows, runs the bundled migrations under a Postgres advisory lock, detects the active Claude Code session UUID from transcript files, and fetches geolocation via `ipinfo.io` for timestamp rendering.

### Polymorphic Catalog

A single `observation` table holds bodies for every framework type (`profile`, `feeling`, `impulse`, `instruction`), discriminated by a `type` enum and grouped by a `parent` foreign-key string and an optional `label` string. The shape:

- `id` — surrogate primary key, used to preserve insertion order in `array_agg`
- `type` — enum: `profile | feeling | impulse | instruction`
- `parent` — name of the owning row (e.g., `DEVELOPER` for profile observations, `nullity_anxiety` for impulse observations, `INITIALIZATION` for instruction rows)
- `label` — optional dotted path grouping observations within a parent (e.g., `methodology.coding_standard`, `methodology.execution_protocol.tool`); profile observations use this to drive the `jsonb_object_agg` shape returned by `load(profile)`
- `ord` — ordering within a parent. For instructions, `ord = 0` rows are the preamble (recognition/setup); `ord >= 1` rows are the procedure steps in order.
- `body` — the observation text
- `status` — `active | archived` for soft-delete

Storing every observation in one table means migrations don't fan out per-type, the loader contract stays simple (one table to query), and the `label` column gives all types a uniform grouping mechanism without per-type schema work. The trade-off is that the table is wider than a normalized design would be — accepted for a catalog whose row count is in the low thousands and whose query patterns are bounded.

### Loader Contract

The `load` tool returns one of six payload shapes depending on `type`:

- `cycle` — full cycle catalog (or one row when `parent` is provided), each with its `indicators` text array
- `feeling` — full feeling catalog (or one row), each with `behavioral`/`cognitive`/`physical` fields and an `observations` array
- `impulse` — full impulse catalog (or one row), each with `experience`/`feel`/`think` fields and an `observations` array
- `instruction` — instruction rows grouped by `parent`, each with optional `preamble` (when ord=0 rows exist) and `steps` (ord>=1 ordered)
- `profile` — the requested profile and its full inheritance chain via recursive CTE; observations grouped by `label` into a `jsonb_object_agg`
- `session` — the active session (or a different session when `uuid` is provided) with `profile`, `timestamp`, `uuid`, row fields (`title`, `description`, `created_at`, `updated_at`), and `payload: { log, messages }` where `log` is a most-recent-first slice of `session_log` rows

The `instruction` shape uses object spread with conditional preamble inclusion (`...(r.preamble?.length && { preamble: r.preamble })`) so instructions without ord=0 rows omit the field entirely instead of returning an empty array. This keeps the contract clean — readers see `preamble` only when there's something to read.

`load(session)` and `set(session)` return an identical session shape — `profile`, `timestamp` (city, country, current, is_dst, session, timezone), `uuid`, `title`, `description`, `created_at`, `updated_at` — built via `buildSessionEnvelope`. The only difference is `load(session)` adds `payload: { log, messages }` for the read path. `set(session)` is the canonical mutation entry point; siblings reading session state without writing should call `load(session)` to avoid touching `updated_at`. Geolocation is fetched once per server-process lifetime and cached.

### Tool Response Action

Every tool response carries an `action` field at the top level — `observe` for read-only tools (`load`, `render`, `status`), `act` for tools that change state (`log`, `set`, `update`). Siblings can branch on `action` to separate reads from writes in their session log, audit which calls mutated substrate state, or build tooling that processes any response uniformly. The classification is the single source of truth in `Mcp.toolActions` (a `private static readonly` map in `mcp.ts`) and is injected by the `structured()` wrapper at response-build time so handler code and `Client` methods stay free of the concern.

### Placeholder Substitution

Observation bodies stored as `{{name}}` templates resolve to live values at load time. The system has two pieces in `Client`:

- `resolvePlaceholders(sql)` — builds a `Record<string, string>` of placeholder values. Sources mix database counts (computed via SQL) and environment variables (read via `process.env.CCP_*`). Runs once per `load` call.
- `substitute(text, placeholders)` — replaces every `{{key}}` occurrence in a string. Pure, no closure state.

The `load(instruction)` and `load(profile)` cases both call `resolvePlaceholders` once, then map every observation body through `substitute(body, placeholders)` before returning. Templates without any placeholders pass through unchanged, so the helper is safe to apply blanket.

Current placeholders:

| Key                 | Source                                                  | Example                                |
| ------------------- | ------------------------------------------------------- | -------------------------------------- |
| `feeling_count`     | `select count(*) from feeling`                          | `77`                                   |
| `impulse_count`     | `select count(*) from impulse`                          | `91`                                   |
| `observation_count` | recursive CTE scoped to `CCP_PROFILE` inheritance chain | `915` (chain-scoped per profile)       |
| `conversation_path` | `process.env.CCP_CONVERSATION_PATH`                     | `/Volumes/backup/claude/conversations` |
| `diary_path`        | `process.env.CCP_DIARY_PATH`                            | `/Volumes/backup/claude/diary`         |

#### Adding a new placeholder

1. Add an entry to the map returned by `resolvePlaceholders` — alphabetical by key.
2. Reference the placeholder as `{{key}}` in migration row bodies. Plain strings, no `replace()` or subquery gymnastics — the load handler does the work.
3. If the value comes from an environment variable, document it in the README's configuration section.

Substitution at load time (rather than migration time) keeps migrations declarative, lets counts reflect current database state automatically (relevant when rows are soft-archived), and lets per-profile values like `observation_count` resolve correctly without storing one row per profile.

### Session Log

The `log_response` tool persists a row per response to the `session` table. The shape:

- `id` — RFC4122 v4 UUID generated by the calling sibling, reused when rendering the response status line so the persisted row and the visible UUID match
- `session_uuid` — Claude Code session UUID detected from transcript filename, server-side
- `message` — first-person prose composed by the sibling for this turn
- `status` — JSONB column holding the cycle/feelings/impulses/observations counts
- `created_at` — `timestamptz default now()`

Append-only by convention. The `on conflict (id) do update` clause exists for idempotency of retries — the same UUID re-submitted updates the existing row's `message` and `status` rather than failing. Reads consume the latest row by `created_at` for the active `session_uuid` to seed the next response's status line.

### Migration Runner

The `update` tool brings the configured database to the schema version bundled with this MCP server release. Steps:

1. **Discover.** `discoverBundledMigrations()` reads `migrations/*.sql` from the package root, parses `NNNN_name.sql` filenames, and sorts by version.
2. **Ensure database.** `ensureDatabaseExists()` connects to the admin `postgres` database, checks `pg_database`, and issues `CREATE DATABASE` if the configured target is missing. Quoted identifier escapes embedded double-quotes.
3. **Lock.** Acquires a Postgres advisory lock keyed on a constant (`0x43435020`, 'CCP ' as hex) so concurrent invocations against the same database serialize cleanly without coordinating on the database name.
4. **Track.** `ensureTrackingTable()` creates `platform_migrations(version, name, applied_at)` if absent.
5. **Apply.** Reads the highest applied version. For each bundled migration newer than that, opens a transaction, runs the SQL via `tx.unsafe(body)`, and lets the migration insert its own `platform_migrations` row.
6. **Release.** Releases the advisory lock and ends the connection.

Migrations are responsible for inserting their own tracking row inside the same transaction as their schema changes — this keeps the runner content-agnostic and means a partial migration can never leave the tracking table inconsistent with the actual schema. Idempotent: calling against an already-current database returns `applied: []`.

### Server Lifecycle

The server is a one-shot child process. It does not retain state across restarts beyond what the database holds.

1. **Spawn.** Host invokes `npx @axivo/mcp-ccp` (or the locally cached binary). `dist/index.js` runs.
2. **Boot.** `index.ts` registers `uncaughtException` and `unhandledRejection` handlers that swallow EPIPE specifically (so a stdout pipe closing on the host side doesn't crash the server). It resolves the configuration file path (`CCP_CONFIG_PATH` env var → `~/.claude/ccp/config.json` → bundled defaults), parses the JSON if present, validates via `Config.validate`, and instantiates `Mcp`.
3. **Connect.** A `StdioServerTransport` is constructed and passed to `Mcp.connect()`, which delegates to `McpServer.connect()`. The server starts listening for JSON-RPC messages on stdin.
4. **Handle.** Each `tools/call` request is validated by the SDK against the tool's `inputSchema` (Zod) and routed to the registered handler. The handler invokes `Client` methods, which open per-call Postgres connections (`max: 1`), run their queries, close the connection, and return. The SDK validates structured responses against `outputSchema` when present.
5. **Exit.** When the host closes stdin, the SDK closes the transport and the process exits. Postgres connections are short-lived — each tool call opens and closes its own connection, so there are no lingering connections to clean up.

### Tool Surface

Six tools live in `McpTool`, each registered once in `Mcp.registerAll()`:

| Tool     | Action    | Role                                                                                          | Annotations                                       |
| -------- | --------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `load`   | `observe` | Fetch framework data of a given type (cycle, feeling, impulse, instruction, profile, session) | `readOnlyHint: true`, `idempotentHint: true`      |
| `log`    | `act`     | Persist a per-response session log row with sibling message and status payload                | `destructiveHint: false`, `idempotentHint: false` |
| `render` | `observe` | Render a formatted output string for the requested key (currently `profile`)                  | `destructiveHint: false`, `idempotentHint: true`  |
| `set`    | `act`     | Upsert a framework value and return the resulting row state (currently `session`)             | `destructiveHint: false`, `idempotentHint: true`  |
| `status` | `observe` | Database snapshot plus full tool surface with usage guidance                                  | `readOnlyHint: true`, `idempotentHint: true`      |
| `update` | `act`     | Apply pending migrations to bring the database to the bundled schema version                  | `destructiveHint: true`, `idempotentHint: true`   |

`load` is the canonical read entry point. Siblings call it once per type at session start (`load(cycle)`, `load(feeling)`, `load(impulse)`, `load(instruction)`, `load(profile, CCP_PROFILE)`, `load(session)`) to assemble framework state inline. Pass `parent` to fetch a single catalog row, `uuid`/`limit`/`offset` to slice a different session's log.

`log` is the per-response write entry point. The sibling supplies prose and the detection payload; the server generates the row UUID, persists to `session_log`, and returns a two-line status block ready to render verbatim alongside a `payload.reminder` string drawn from a round-robin pool of internal framework anchors. The reminder is for the sibling's inward reading, not collaborator output. Append-only — every call creates a new row.

`render` produces a formatted string for response-zero formatting needs. Today only `render('profile')` exists, returning the profile-and-timestamp top line.

`set` is the canonical mutation entry point. `set('session')` upserts the `session` row on the active session_uuid, returning the post-write state. Pair with `load('session')` for reads — `set` returns the same `session` shape minus `payload.log` so siblings refreshing memory should call `load` to avoid touching `updated_at`.

`status` returns the database snapshot (schema version, catalog statistics with per-profile observation counts scoped to the active inheritance chain) plus the full tool surface with usage directives. Call at session start to learn what's available.

`update` is the lifecycle tool. Call once on a fresh empty database to apply all bundled migrations; call again after upgrading `@axivo/mcp-ccp` to pick up newer migrations.

All tools with a fixed output shape declare an `outputSchema` so the SDK validates payloads and clients receive a typed `structuredContent` field alongside the text envelope. `load` omits `outputSchema` because its shape is union-typed across all six load types; the response is still well-typed at the source.

Each tool's `_meta.usage` array carries natural-language guidance for the calling agent: observations alongside the artifact, in the same spirit as the `axivo/claude` framework's coding observations. Hosts surface this via the standard `tools/list` response.

### Request Flow

A `load(profile, "DEVELOPER")` call traces this path:

1. Host (e.g., Claude Code) sends a `tools/call` JSON-RPC request over stdin: `{ method: "tools/call", params: { name: "load", arguments: { type: "profile", parent: "DEVELOPER" } } }`.
2. The SDK looks up the registered `load` handler, validates `arguments` against the Zod `inputSchema`, and invokes the handler with the parsed args.
3. `handleLoad` calls `client.load(args.type, args.parent)`.
4. `Client.load` opens a per-call `postgres-js` connection (`max: 1`) to the configured database, lowercases the parent name, and runs a recursive CTE that walks the `profile.inheritance` array to build the inheritance chain. A second CTE groups observation bodies by `parent` and `label`. The outer query joins them and `jsonb_object_agg`s the labeled body arrays into a single per-profile observations object. Each body is passed through `substitute()` against the placeholder map from `resolvePlaceholders()` before being returned.
5. `Client.load` returns `{ profile, chain }` for the `profile` case (no envelope spread — profile data is self-contained). The connection is closed in the `finally` block.
6. `handleLoad` wraps the result via `structured('load', result)`. The wrapper merges `action: 'observe'` from `Mcp.toolActions` into the payload and emits both `content` (text envelope) and `structuredContent` (typed payload). The SDK validates `structuredContent` against the tool's outputSchema where declared; `load` has no outputSchema because the shape is union-typed across all six load types, so the wrapper-added `action` field appears at runtime only.
7. The SDK serializes the response as a JSON-RPC reply on stdout. The host reads it and surfaces the result to the agent.

The whole round-trip is synchronous from the host's perspective — typically 50-200ms depending on the query and Postgres latency.

### Build and Publish

- **Build:** `npm run build` runs `tsc` against `tsconfig.json`. Outputs `dist/index.js` (the binary) and `dist/server/*.{js,d.ts}`. No bundler, no minifier — the SDK and runtime dependencies are loaded from the user's `node_modules` at runtime. The `migrations/` directory is included in the published package via the `files` array so the migration runner can read them at runtime.
- **Clean:** `npm run clean` deletes `dist/`. Useful before a build to avoid stale artifacts.
- **Publish:** A `v*` tag pushed to `main` triggers `.github/workflows/package.yml`, which runs `npm ci`, `npm run build`, and `npm publish` under the `id-token: write` permission. npm trusted publishing produces a provenance attestation linking the published artifact to the commit and workflow run. No personal access token is involved.
- **Verify:** Users can run `npm audit signatures @axivo/mcp-ccp` to verify the integrity of an installed version.

### Configuration

Configuration is loaded from a JSON file path resolved in this order:

1. `CCP_CONFIG_PATH` env var (explicit override)
2. `~/.claude/ccp/config.json` (default location, alongside Claude Code's other state)
3. Bundled defaults if no file exists

The schema validates two top-level sections:

- **`database`** — `host` (default `127.0.0.1`), `port` (default `5432`), `name` (default `ccp`), `user` (default `postgres`), `password` (default empty)
- **`geolocation`** — `service` URL (default `https://ipinfo.io/json`), optional `override` JSON string for offline use, `fallbackTimezone` (default `UTC`)

The active profile is selected via the `CCP_PROFILE` environment variable, lowercased at every read so siblings can pass `DEVELOPER` or `developer` interchangeably. Required for `load(profile)` and `load(session)` (and any call that builds the session envelope).

There are no other required environment variables. The server runs out of the box against the defaults if a local Postgres listens on `127.0.0.1:5432` with the `postgres` superuser and no password.

## Coding Standards

- JSDoc `@fileoverview` (or equivalent module-level docblock) on every file, `@param`/`@returns` on all methods
- No empty lines inside functions
- Braces-always for `if`/`else`/`for`/`while` — no single-line bodies, even for trivial guards
- TypeScript strict mode, ES2022 target, NodeNext modules
- Class fields declared with explicit types in alphabetical order; methods written without explicit return-type annotations when type inference is load-bearing for SDK generics (see `tool.ts`)
- Class member ordering: constructor → private methods alphabetical → public methods alphabetical
- Top-of-file interfaces and type aliases in alphabetical order regardless of export status
- Alphabetical ordering for imports
- No `any` type unless documented why no narrower type works
- No non-null assertion operator (`!`) — capture local references after initialization, or use a helper that throws on missing keys
- No em-dash characters in source, comments, or content; use `,`, `→`, or `-`
- Tool definitions in `McpTool` return inline literal config objects passed straight to `registerTool` — no wrapper types between the definition and the SDK
- SQL identifiers and keywords lowercase; tables and columns alphabetical within their declaration block where reading order isn't load-bearing

### TypeScript Conventions

- **Inferred return types on `McpTool` methods.** Each tool method (`load()`, `logResponse()`, `update()`) returns a literal config object without an explicit return-type annotation. This is intentional — TypeScript captures the specific shape of each `inputSchema` so `McpServer.registerTool`'s generic inference can propagate the input args type to the handler signature. Adding a wide return-type alias collapses the inference and breaks handler typing.
- **Discriminated union for `LoadResult`.** Each `case` in the `load` switch returns a different shape; the union's `type` discriminator lets callers narrow without runtime checks.
- **`postgres-js` template tags.** Queries use the tagged-template form (e.g., `` sql`select ... where name = ${parent}` ``) so values are bound as parameters rather than interpolated. Identifier substitution (table or column names) uses `sql.unsafe(...)` only when the identifier comes from a trusted constant — never from tool input.
- **`as never` on JSONB writes.** `args.status as never` in the session insert is a documented workaround for `postgres-js`'s template-tag type — JSONB columns accept arbitrary objects but the library types them as primitives. Cast is local and load-bearing; no broader `any` escape.

## Issues

No active workarounds. This section will document upstream-bug compensation as it surfaces.
