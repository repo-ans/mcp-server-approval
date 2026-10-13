-- Housecall Pro MCP server schema. Run in Supabase: SQL Editor > New query > paste > Run.
-- The server uses the service role key (bypasses RLS). RLS is enabled with no policies,
-- so the public anon key cannot read or write any of these tables.

create extension if not exists pgcrypto;

-- API keys for AI agents. Only the sha256 hash of each key is stored.
create table if not exists agents (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  role          text not null check (role in ('read_only', 'writer')),
  api_key_hash  text not null unique,
  created_at    timestamptz not null default now()
);

-- Every MCP tool call (success, failure, permission rejection, approval lifecycle).
create table if not exists tool_calls (
  id          uuid primary key default gen_random_uuid(),
  agent       text not null,
  tool        text not null,
  inputs      jsonb,
  result      jsonb,
  status      text not null check (status in ('success', 'error', 'pending_approval', 'approved', 'rejected', 'rejected_permission')),
  latency_ms  integer,
  created_at  timestamptz not null default now()
);
create index if not exists tool_calls_created_at_idx on tool_calls (created_at desc);
create index if not exists tool_calls_agent_idx on tool_calls (agent);

-- Write actions waiting for a human decision in Slack (used from Phase 3).
create table if not exists approval_requests (
  id          uuid primary key default gen_random_uuid(),
  agent       text not null,
  tool        text not null,
  inputs      jsonb not null,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'failed')),
  result      jsonb,
  slack_ts    text,
  decided_by  text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create index if not exists approval_requests_status_idx on approval_requests (status);

alter table agents            enable row level security;
alter table tool_calls        enable row level security;
alter table approval_requests enable row level security;
