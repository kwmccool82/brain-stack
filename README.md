# Brain Stack

Personal knowledge infrastructure powered by Supabase, MCP, and Claude. Two layers:

1. **Brain** — Captures thoughts, documents, and facts with semantic embeddings. Any AI client can search and retrieve your knowledge via MCP.
2. **Life Engine** — Proactive assistant that runs on a schedule, checks your calendar and tasks, and sends context-rich briefings to Telegram.

Together: you talk to Claude naturally, it stores what matters, and it proactively surfaces the right context at the right time.

## Architecture

```
You ──→ Claude Code ──→ Brain MCP Server ──→ Supabase (thoughts, docs, tasks)
                │                                    │
                ├── Google Calendar MCP               │
                │                                    │
                └── Telegram ←── Life Engine ←── Scheduled Trigger
                                    │
                                    └── send_telegram_message() via pg_net
```

## What You Need

- [Supabase](https://supabase.com) account (free tier works)
- [OpenRouter](https://openrouter.ai) API key (for embeddings via text-embedding-3-small)
- [Claude Code](https://claude.ai/claude-code) CLI
- [Telegram Bot](https://core.telegram.org/bots#botfather) (for Life Engine notifications)
- Google Calendar connected via [Claude.ai MCP connector](https://claude.ai/settings/connectors)

## Setup

### Step 1: Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Note your **project ref** (in the URL: `supabase.com/project/YOUR_PROJECT_REF`)
3. Go to Settings > API and copy:
   - **Project URL** (e.g., `https://YOUR_PROJECT_REF.supabase.co`)
   - **Service Role Key** (under "service_role", not "anon")

### Step 2: Run Schema Migrations

In the Supabase SQL Editor, run each file in order:

1. `schema/001_core_brain.sql` — Core tables (thoughts, documents, chunks, search functions)
2. `schema/002_life_engine.sql` — Life Engine tables (tasks, habits, briefings, check-ins)
3. `schema/003_telegram_helper.sql` — Telegram messaging function (**edit bot token and chat ID first**)
4. `schema/004_heartbeat_watchdog.sql` — Optional: liveness monitoring (**edit bot token and chat ID first**)

> **Important**: Before running 003 and 004, replace `YOUR_TELEGRAM_BOT_TOKEN` and `YOUR_TELEGRAM_CHAT_ID` with your actual values.

### Step 3: Get an OpenRouter API Key

1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Create an API key
3. Add credits ($5 is plenty to start — embeddings are cheap)

### Step 4: Set Up Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Then set the secrets on your Supabase project:

```bash
supabase secrets set --project-ref YOUR_PROJECT_REF \
  OPENROUTER_API_KEY=your-key \
  MCP_ACCESS_KEY=$(openssl rand -hex 32)
```

Note your `MCP_ACCESS_KEY` — you'll need it to connect the MCP server.

### Step 5: Deploy the MCP Edge Function

```bash
# Install Supabase CLI if you haven't
npm install -g supabase

# Deploy the brain MCP server (--no-verify-jwt is required for MCP connectors)
supabase functions deploy brain-mcp --use-api --project-ref YOUR_PROJECT_REF --no-verify-jwt
```

Your MCP server is now live at:
```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/brain-mcp?key=YOUR_MCP_ACCESS_KEY
```

### Step 6: Connect to Claude

#### Option A: Claude.ai MCP Connector (recommended)
1. Go to [claude.ai/settings/connectors](https://claude.ai/settings/connectors)
2. Add a new MCP connector with the URL from Step 5
3. Name it something like "brain-stack"

#### Option B: Claude Code local config
Add to your Claude Code MCP settings:
```json
{
  "mcpServers": {
    "brain-stack": {
      "type": "url",
      "url": "https://YOUR_PROJECT_REF.supabase.co/functions/v1/brain-mcp?key=YOUR_MCP_ACCESS_KEY"
    }
  }
}
```

### Step 7: Test It

In Claude, try:
- "Capture this thought: I want to build a personal knowledge system"
- "Search my thoughts for knowledge system"
- "Add task: Set up Life Engine"
- "List my tasks"

## Life Engine Setup

The Life Engine is the proactive layer — it sends you briefings via Telegram on a schedule.

### Step 7a: Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the **bot token**
4. Message your new bot to start a chat
5. Get your **chat ID** by visiting: `https://api.telegram.org/botYOUR_TOKEN/getUpdates` — look for `chat.id` in the response

### Step 7b: Update the Telegram Helper

Run in the Supabase SQL Editor (or re-run 003 with your values):

```sql
CREATE OR REPLACE FUNCTION send_telegram_message(msg text, parse_mode text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  bot_token text := 'YOUR_ACTUAL_BOT_TOKEN';
  chat_id text := 'YOUR_ACTUAL_CHAT_ID';
  request_id bigint;
  body_json jsonb;
BEGIN
  body_json := json_build_object('chat_id', chat_id, 'text', msg)::jsonb;
  IF parse_mode IS NOT NULL AND parse_mode IN ('HTML', 'MarkdownV2', 'Markdown') THEN
    body_json := body_json || json_build_object('parse_mode', parse_mode)::jsonb;
  END IF;
  SELECT net.http_post(
    url := 'https://api.telegram.org/bot' || bot_token || '/sendMessage',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := body_json
  ) INTO request_id;
  RETURN request_id;
END; $$;
```

Test it:
```sql
SELECT send_telegram_message('Brain Stack is alive!');
```

### Step 7c: Set Up the Scheduled Trigger

In Claude Code, use `/schedule` to create a remote trigger:

- **Cron**: `0 10,14,18,1 * * *` (runs at 6 AM, 10 AM, 2 PM, 9 PM ET — adjust UTC offsets for your timezone)
- **MCP connections**: Google Calendar, your brain-stack connector, Supabase
- **Prompt**: The Life Engine prompt needs to be self-contained since remote triggers can't read local files. See `skills/life-engine/SKILL.md` for the full behavior spec — adapt it into the trigger prompt, replacing Telegram plugin calls with `SELECT send_telegram_message(...)` via Supabase `execute_sql`.

### Step 7d: Connect Google Calendar

1. Go to [claude.ai/settings/connectors](https://claude.ai/settings/connectors)
2. Add the Google Calendar MCP connector
3. Authorize access to your calendar

## Optional: Slack Capture

The `ingest-thought` edge function lets you capture thoughts by posting to a Slack channel.

1. Create a Slack app with Event Subscriptions
2. Subscribe to `message.channels` events
3. Set the Request URL to: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/ingest-thought`
4. Set Supabase secrets:
   ```bash
   supabase secrets set --project-ref YOUR_PROJECT_REF \
     SLACK_BOT_TOKEN=xoxb-your-token \
     SLACK_CAPTURE_CHANNEL=C0123456789
   ```
5. Deploy: `supabase functions deploy ingest-thought --use-api --project-ref YOUR_PROJECT_REF`

## Optional: Telegram Channel for Claude Code

If you want to interact with your brain via Telegram (ask questions, add tasks conversationally):

1. Install the Telegram plugin in Claude Code: it's `plugin:telegram` from `claude-plugins-official`
2. Configure access via `/telegram:configure` with your bot token
3. Add yourself to the allowlist via `/telegram:access`
4. Keep a Claude Code session running (e.g., on a Mac Mini)

Messages you send to the bot will arrive as channel events in Claude Code, which can route them to your brain MCP tools.

## File Structure

```
brain-stack/
├── README.md
├── CLAUDE.md              # Claude Code project context
├── .env.example           # Environment variable template
├── .gitignore
├── schema/
│   ├── 001_core_brain.sql          # Thoughts, documents, search functions
│   ├── 002_life_engine.sql         # Tasks, habits, briefings, check-ins
│   ├── 003_telegram_helper.sql     # send_telegram_message() via pg_net
│   └── 004_heartbeat_watchdog.sql  # Liveness monitoring (optional)
├── supabase/
│   ├── config.toml
│   └── functions/
│       ├── brain-mcp/              # MCP server edge function
│       │   ├── index.ts
│       │   ├── deno.json
│       │   └── .npmrc
│       └── ingest-thought/         # Slack capture edge function (optional)
│           ├── index.ts
│           ├── deno.json
│           └── .npmrc
└── skills/
    └── life-engine/
        └── SKILL.md                # Life Engine behavior spec
```

## How It Works

### Knowledge Capture
- **MCP**: Any Claude client (Claude.ai, Claude Code, API) can call `capture_thought` to save a thought with auto-generated embeddings and metadata
- **Slack**: Post to a designated channel and the `ingest-thought` function captures it automatically
- **Documents**: Ingest PDFs, markdown, images via Claude Code — chunks are embedded for semantic search

### Knowledge Retrieval
- **Semantic search**: `search_thoughts` uses pgvector cosine similarity across thoughts AND document chunks
- **Filtered listing**: `list_thoughts` with filters for type, topic, person, date range
- **Life Engine data**: `search_facts` queries briefings, check-ins, evolution history

### Life Engine
- Runs as a Claude Code scheduled trigger (cloud-hosted, survives session restarts)
- Checks time window → gathers calendar + tasks + habits → sends Telegram briefing
- Logs every briefing to prevent duplicates
- Self-improvement protocol suggests behavior changes weekly based on response patterns
