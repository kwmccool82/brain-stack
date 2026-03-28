-- ============================================================
-- 002_life_engine.sql
-- Life Engine tables: tasks, habits, briefings, check-ins, evolution
-- These power the proactive assistant layer
-- ============================================================

-- ============================================================
-- TASKS: Personal task system
-- ============================================================
create table if not exists life_engine_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default '00000000-0000-0000-0000-000000000001'::uuid,
  title text not null,
  status text default 'pending',        -- pending, done, cancelled
  due_date date,
  priority text default 'normal',       -- high, normal, low
  notes text,
  created_at timestamptz default now(),
  completed_at timestamptz
);

-- ============================================================
-- HABITS: Tracked habits with frequency
-- ============================================================
create table if not exists life_engine_habits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  description text,
  frequency text default 'daily',       -- daily, weekly
  time_of_day text default 'morning',   -- morning, afternoon, evening
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- HABIT LOG: Completion records
-- ============================================================
create table if not exists life_engine_habit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  habit_id uuid references life_engine_habits(id),
  completed_at timestamptz default now(),
  notes text
);

-- ============================================================
-- BRIEFINGS: Log of all messages sent by Life Engine
-- ============================================================
create table if not exists life_engine_briefings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  briefing_type text not null,          -- morning, pre_meeting, checkin, afternoon, evening, self_improvement
  content text not null,
  delivered_via text default 'telegram',
  user_responded boolean default false,
  created_at timestamptz default now()
);

-- ============================================================
-- CHECK-INS: Mood/energy/status check-in responses
-- ============================================================
create table if not exists life_engine_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  checkin_type text,                    -- mood, energy, status
  value text,
  notes text,
  created_at timestamptz default now()
);

-- ============================================================
-- EVOLUTION: Self-improvement suggestions
-- ============================================================
create table if not exists life_engine_evolution (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  change_type text,                     -- add, remove, modify
  description text,
  reason text,
  approved boolean default false,
  applied_at timestamptz,
  created_at timestamptz default now()
);

-- ============================================================
-- TASTE PREFERENCES (optional): Interaction style calibration
-- ============================================================
create table if not exists taste_preferences (
  id uuid primary key default gen_random_uuid(),
  preference_name text not null,
  domain text,                          -- communication, work, interaction
  want text,                            -- what the user values
  reject text,                          -- what the user doesn't want
  constraint_type text,
  created_at timestamptz default now()
);

-- ============================================================
-- INDEXES
-- ============================================================
create index idx_tasks_status on life_engine_tasks(status);
create index idx_tasks_due on life_engine_tasks(due_date);
create index idx_habits_active on life_engine_habits(active);
create index idx_habit_log_completed on life_engine_habit_log(completed_at desc);
create index idx_briefings_created on life_engine_briefings(created_at desc);
create index idx_checkins_created on life_engine_checkins(created_at desc);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table life_engine_tasks enable row level security;
alter table life_engine_habits enable row level security;
alter table life_engine_habit_log enable row level security;
alter table life_engine_briefings enable row level security;
alter table life_engine_checkins enable row level security;
alter table life_engine_evolution enable row level security;
alter table taste_preferences enable row level security;

create policy "Service role full access" on life_engine_tasks for all using (auth.role() = 'service_role');
create policy "Service role full access" on life_engine_habits for all using (auth.role() = 'service_role');
create policy "Service role full access" on life_engine_habit_log for all using (auth.role() = 'service_role');
create policy "Service role full access" on life_engine_briefings for all using (auth.role() = 'service_role');
create policy "Service role full access" on life_engine_checkins for all using (auth.role() = 'service_role');
create policy "Service role full access" on life_engine_evolution for all using (auth.role() = 'service_role');
create policy "Service role full access" on taste_preferences for all using (auth.role() = 'service_role');

-- Log migration
insert into schema_log (migration_name, description, sql_executed)
values (
  '002_life_engine',
  'Life Engine tables: tasks, habits, habit_log, briefings, checkins, evolution, taste_preferences.',
  '002_life_engine.sql'
);
