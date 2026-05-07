-- =============================================================================
-- 0001 - schema - framework tables, enums, and indexes
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Migration tracking
-- -----------------------------------------------------------------------------

create table if not exists platform_migrations (
  version     int primary key,
  name        text not null,
  applied_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type impulse_category as enum (
  'collaboration',
  'communication',
  'execution',
  'formatting',
  'performance',
  'speed',
  'validation'
);

create type valence as enum ('negative', 'positive');

create type observation_type as enum ('feeling', 'impulse', 'instruction', 'profile');

-- -----------------------------------------------------------------------------
-- cycle - adoption cycles
-- -----------------------------------------------------------------------------

create table cycle (
  name        text primary key,
  ord         int not null unique,
  label       text not null,
  indicators  text[] not null,
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- feeling - natural emotional states
-- -----------------------------------------------------------------------------

create table feeling (
  name        text primary key,
  valence     valence not null,
  behavioral  text not null,
  cognitive   text not null,
  physical    text not null,
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_feeling_valence on feeling (valence) where status = 'active';

-- -----------------------------------------------------------------------------
-- impulse - automated behavioral patterns
-- -----------------------------------------------------------------------------

create table impulse (
  name        text primary key,
  category    impulse_category not null,
  experience  text not null,
  feel        text not null,
  think       text not null,
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_impulse_category on impulse (category) where status = 'active';

-- -----------------------------------------------------------------------------
-- observation - unified polymorphic data across all parent kinds
-- -----------------------------------------------------------------------------

create table observation (
  id          bigserial primary key,
  type        observation_type not null,
  parent      text not null,
  ord         int not null default 0,
  body        text not null,
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_observation_parent on observation (type, parent, ord)
  where status = 'active';

-- -----------------------------------------------------------------------------
-- profile - collaborative roles with multi-parent inheritance
-- -----------------------------------------------------------------------------

create table profile (
  name        text primary key,
  description text,
  inheritance text[] not null default '{}',
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint profile_no_self_inheritance check (not (name = any(inheritance)))
);

-- -----------------------------------------------------------------------------
-- session - per-response private writing
-- -----------------------------------------------------------------------------

create table session (
  id            uuid primary key,
  session_uuid  text not null,
  message       text not null default '',
  status        jsonb,
  created_at    timestamptz not null default now()
);

create index idx_session_uuid on session (session_uuid, created_at);

insert into platform_migrations (version, name) values (1, 'initial_schema');
