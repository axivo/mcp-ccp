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

A small TypeScript server, ~1,300 lines of source, that exposes the CCP framework's Postgres tables (cycles, feelings, impulses, instructions, profiles, observations) as MCP tools for retrieval and a per-response session log for write-back. There is no daemon, no listening socket, no HTTP server — the host (e.g., Claude Code) spawns the server as a child process, communicates over stdio, and tears it down when the host exits. The server connects directly to a Postgres instance configured by the user (local, Supabase, or any reachable Postgres) and runs bundled SQL migrations on demand.

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
- `profile` — the requested profile and its full inheritance chain via recursive CTE; observations grouped by `label` into a `jsonb_object_agg`; envelope (timestamp + session state) attached
- `session` — just the envelope (timestamp + session state), no catalog data

The `instruction` shape uses object spread with conditional preamble inclusion (`...(r.preamble?.length && { preamble: r.preamble })`) so instructions without ord=0 rows omit the field entirely instead of returning an empty array. This keeps the contract clean — readers see `preamble` only when there's something to read.

The `profile` and `session` payloads carry an `envelope` object built by `buildSessionEnvelope`. The envelope holds the active profile name, the last response's status (cycle, feelings, impulses, observations counts) read from the `session` table, the detected `session_uuid`, and a timestamp object (city, country, ISO datetime, weekday, DST status, IANA timezone). Geolocation is fetched once per server-process lifetime and cached.

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

Three tools live in `McpTool`, each registered once in `Mcp.registerAll()`:

| Tool           | Role                                                              | Annotations                                       |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| `load`         | Fetch framework data of a given type (cycle, feeling, impulse, instruction, profile, session) | `readOnlyHint: true`, `idempotentHint: true`      |
| `log_response` | Persist a per-response session row with sibling message and status payload | `destructiveHint: false`, `idempotentHint: false` |
| `update`       | Apply pending migrations to bring the database to the bundled schema version | `destructiveHint: true`, `idempotentHint: true`   |

`load` is the single read entry point — siblings call it once per type at session start (`load(cycle)`, `load(feeling)`, `load(impulse)`, `load(profile, CCP_PROFILE)`, plus `load(instruction)`) to assemble framework state inline without spilling. Pass `parent` to fetch a single row.

`log_response` is the single write entry point during normal operation. The sibling generates the row UUID before calling and reuses it when rendering the response status line at step 29 of the response protocol. Append-only by convention; the `on conflict do update` clause exists for retry idempotency.

`update` is the lifecycle tool. Call once on a fresh empty database to apply all bundled migrations; call again after upgrading `@axivo/mcp-ccp` to pick up newer migrations.

All three tools declare `outputSchema` so the SDK validates payloads and clients receive a typed `structuredContent` field alongside the text envelope.

Each tool's `_meta.usage` array carries natural-language guidance for the calling agent: observations alongside the artifact, in the same spirit as the `axivo/claude` framework's coding observations. Hosts surface this via the standard `tools/list` response.

### Request Flow

A `load(profile, "DEVELOPER")` call traces this path:

1. Host (e.g., Claude Code) sends a `tools/call` JSON-RPC request over stdin: `{ method: "tools/call", params: { name: "load", arguments: { type: "profile", parent: "DEVELOPER" } } }`.
2. The SDK looks up the registered `load` handler, validates `arguments` against the Zod `inputSchema`, and invokes the handler with the parsed args.
3. `handleLoad` calls `client.load(args.type, args.parent)`.
4. `Client.load` opens a per-call `postgres-js` connection (`max: 1`) to the configured database, lowercases the parent name, and runs a recursive CTE that walks the `profile.inheritance` array to build the inheritance chain. A second CTE groups observation bodies by `parent` and `label`. The outer query joins them and `jsonb_object_agg`s the labeled body arrays into a single per-profile observations object.
5. After the chain query, `buildSessionEnvelope` runs — fetches geolocation (cached after first call), generates the timestamp object for the resolved IANA timezone, queries the `session` table for the active session's first row (start time) and last row (status payload), and assembles the envelope.
6. `Client.load` returns `{ type: 'profile', profile, chain, ...envelope }`. The connection is closed in the `finally` block.
7. `handleLoad` wraps the result via `structured()` so the response carries both `content` (text envelope) and `structuredContent` (typed payload). The SDK validates the structured payload against the tool's outputSchema (none declared yet for `load` — the shape is union-typed across all six load types).
8. The SDK serializes the response as a JSON-RPC reply on stdout. The host reads it and surfaces the result to the agent.

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
