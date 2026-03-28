# Brain Stack

Personal knowledge infrastructure. Supabase backend, MCP protocol, Telegram delivery.

## Quick Reference

- Edge Functions: supabase/functions/
- Schema migrations: schema/
- Life Engine skill: skills/life-engine/SKILL.md

## Database

### Supabase (project ref: YOUR_PROJECT_REF)
- `thoughts` — atomic captures from Slack + MCP
- `documents` — parent records for ingested files
- `document_chunks` — embedded segments with vectors (1536-dim, text-embedding-3-small via OpenRouter)
- `schema_log` — migration history

### Life Engine Tables
- `life_engine_briefings` — logged briefings (prevents duplicates)
- `life_engine_checkins` — mood/energy check-in responses
- `life_engine_habits`, `life_engine_habit_log` — tracked habits and completion records
- `life_engine_evolution` — self-improvement suggestions
- `life_engine_tasks` — title, status, due_date, priority, notes
- `taste_preferences` — interaction style calibration (optional)

### MCP Tools (brain-mcp edge function)
- capture_thought, search_thoughts, list_thoughts, edit_thought, thought_stats
- create_task, complete_task, list_tasks, get_schedule
- search_facts, get_taste_preferences

## Embedding
- Model: openai/text-embedding-3-small via OpenRouter API
- Dimensions: 1536

## Life Engine
Delivers briefings via Telegram based on time windows:
- Morning: calendar + tasks + habits
- Mid-morning: check-in or pre-meeting prep
- Afternoon: pre-meeting prep or follow-ups
- Evening: day summary + tomorrow preview
- Quiet hours: no messages unless imminent meeting

### Telegram
- Bot: @YOUR_BOT_NAME
- Chat ID: YOUR_CHAT_ID

### Google Calendar
- Calendar ID: YOUR_EMAIL@gmail.com
- Timezone: YOUR_TIMEZONE (e.g., America/Detroit)

### Task System
- User says "add task: X" to add, "done: X" to complete
- Morning briefings surface pending tasks automatically

## Deploying Edge Functions
```bash
# MCP function MUST use --no-verify-jwt (MCP connector requires it)
supabase functions deploy brain-mcp --use-api --project-ref YOUR_PROJECT_REF --no-verify-jwt

# Non-MCP functions use default JWT verification
supabase functions deploy ingest-thought --use-api --project-ref YOUR_PROJECT_REF
```

## Environment Variables (Edge Functions)
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- OPENROUTER_API_KEY
- MCP_ACCESS_KEY (brain-mcp only)
- SLACK_BOT_TOKEN (ingest-thought only)
- SLACK_CAPTURE_CHANNEL (ingest-thought only)

## Schema Migrations
- Run migrations in order: 001, 002, 003, 004
- After any schema change, log to `schema_log`
- Convention: NNN_short_description.sql
