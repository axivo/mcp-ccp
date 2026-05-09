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

create type issue_status as enum ('closed', 'in_progress', 'open');

create type issue_tracker as enum ('custom', 'github', 'gitlab', 'jira');

create type observation_type as enum ('feeling', 'impulse', 'instruction', 'profile');

create type project_status as enum ('active', 'archived');

create type task_priority as enum ('high', 'low', 'medium', 'urgent');

create type task_status as enum ('abandoned', 'blocked', 'completed', 'in_progress', 'planned');

create type valence as enum ('negative', 'positive');

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
  label       text,
  ord         int not null default 0,
  body        text not null,
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_observation_parent on observation (type, parent, ord)
  where status = 'active';

create index idx_observation_label on observation (type, parent, label)
  where status = 'active' and label is not null;

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

-- -----------------------------------------------------------------------------
-- project - long-lived container for tasks and team work
-- -----------------------------------------------------------------------------

create table project (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  description    text,
  repository     text,
  documentation  text[] not null default '{}',
  status         project_status not null default 'active',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index idx_project_status on project (status);

-- -----------------------------------------------------------------------------
-- task - unit of work scoped to a project
-- -----------------------------------------------------------------------------

create table task (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references project(id) on delete cascade,
  title          text not null,
  description    text,
  documentation  text[] not null default '{}',
  assignee       text,
  priority       task_priority not null default 'medium',
  status         task_status not null default 'planned',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index idx_task_project on task (project_id);

create index idx_task_status on task (status) where status != 'completed';

-- -----------------------------------------------------------------------------
-- concourse - meeting place between tasks and conversations
-- -----------------------------------------------------------------------------

create table concourse (
  task_id       uuid not null references task(id) on delete cascade,
  session_uuid  text not null,
  created_at    timestamptz not null default now(),
  primary key (task_id, session_uuid)
);

create index idx_concourse_session on concourse (session_uuid);

-- -----------------------------------------------------------------------------
-- issue - external tracker reference scoped to a task
-- -----------------------------------------------------------------------------

create table issue (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references task(id) on delete cascade,
  title       text not null,
  url         text not null,
  tracker     issue_tracker not null,
  status      issue_status not null default 'open',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_issue_task on issue (task_id);

create index idx_issue_tracker on issue (tracker) where tracker = 'github';

insert into platform_migrations (version, name) values (1, 'initial_schema');
