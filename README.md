# Brain Stack

A personal knowledge infrastructure that captures what you think, remembers what matters, and proactively surfaces the right context at the right time. It combines a **brain** (thoughts, documents, tasks with semantic search) and a **Life Engine** (scheduled briefings, habit tracking, meeting prep). Think of it as a chief of staff that lives in your terminal and texts you on Telegram.

## Architecture

```
                         +-------------------+
                         |    Claude Code    |
                         | (always-on Mac)   |
                         +---------+---------+
                                   |
              +--------------------+--------------------+
              |                    |                    |
              v                    v                    v
     +--------+--------+  +-------+-------+  +--------+--------+
     | Brain MCP Server |  | Google Cal MCP|  | Telegram Plugin |
     | (Supabase Edge)  |  | (claude.ai)   |  | (Claude Code)   |
     +--------+--------+  +---------------+  +--------+--------+
              |                                        |
              v                                        v
     +--------+--------+                      +--------+--------+
     |    Supabase DB   |--------------------->|    Telegram Bot  |
     | thoughts, tasks, |  send_telegram_msg() |   (your phone)  |
     | docs, habits,    |                      +-----------------+
     | briefings        |
     +---------+--------+
               ^
               |
     +---------+---------+
     | Scheduled Trigger  |
     | (claude.ai remote) |
     | runs 4x daily      |
     +--------------------+
```

**Claude Code** is the sole orchestrator. It runs continuously on a Mac (Mini, laptop, whatever) and handles:
- **Inbound**: You message a Telegram bot, Claude Code receives it via the Telegram plugin, routes it to brain MCP tools or responds directly
- **Outbound**: A scheduled remote trigger on claude.ai fires 4x daily, checks your calendar and tasks, and sends briefings to Telegram via a Supabase SQL function
- **Storage**: All persistent data lives in Supabase (thoughts, documents, tasks, habits, briefings)
- **Search**: Semantic search via pgvector embeddings (text-embedding-3-small through OpenRouter)

## Prerequisites

You need these accounts and subscriptions before starting:

| Prerequisite | What it's for | Cost |
|---|---|---|
| **Claude Pro/Team/Enterprise subscription** | Claude Code CLI requires a paid Anthropic plan | $20+/mo |
| **Claude Code CLI** | The orchestrator — runs on your Mac, handles all routing | Included with Claude sub |
| **Supabase account** | Database for all persistent data (thoughts, tasks, habits) | Free tier works |
| **OpenRouter API key** | Embeddings (text-embedding-3-small) and metadata extraction (gpt-4o-mini) for the brain MCP server | Pay-per-use, ~$5 to start |
| **Telegram account** | Create a bot for Life Engine notifications and conversational input | Free |
| **Google account** | Calendar integration for meeting prep and briefings | Free |
| **A Mac that stays on** | Claude Code runs continuously to handle Telegram messages | Any Mac (Mini recommended) |

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

**Important**: Before running 003 and 004, replace `YOUR_TELEGRAM_BOT_TOKEN` and `YOUR_TELEGRAM_CHAT_ID` with your actual values.

### Step 3: Get an OpenRouter API Key

1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Create an API key
3. Add credits ($5 is plenty to start — embeddings are cheap)

### Step 4: Deploy the Brain MCP Edge Function

```bash
# Install Supabase CLI if you haven't
npm install -g supabase

# Set secrets on your project
supabase secrets set --project-ref YOUR_PROJECT_REF \
  OPENROUTER_API_KEY=your-key \
  MCP_ACCESS_KEY=$(openssl rand -hex 32)

# Deploy (--no-verify-jwt is required for MCP connectors)
supabase functions deploy brain-mcp --use-api --project-ref YOUR_PROJECT_REF --no-verify-jwt
```

Note your `MCP_ACCESS_KEY` — you need it for the next step.

Your MCP server is now live at:
```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/brain-mcp?key=YOUR_MCP_ACCESS_KEY
```

### Step 5: Connect Brain MCP to Claude.ai

1. Go to [claude.ai/settings/connectors](https://claude.ai/settings/connectors)
2. Add a new MCP connector with the URL from Step 4
3. Name it something like "brain-stack"

This gives Claude.ai (and scheduled triggers) access to your brain tools: `capture_thought`, `search_thoughts`, `list_tasks`, etc.

You can also add it to Claude Code's local MCP config:
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

### Step 6: Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the **bot token**
4. Message your new bot to start a chat
5. Get your **chat ID** by visiting: `https://api.telegram.org/botYOUR_TOKEN/getUpdates` — look for `chat.id` in the response
6. Update `send_telegram_message()` in your database with the real bot token and chat ID (re-run 003 with your values, or use the SQL editor)

Test it:
```sql
SELECT send_telegram_message('Brain Stack is alive!');
```

### Step 7: Set Up Telegram Plugin in Claude Code

1. Install the Telegram plugin in Claude Code (it's `plugin:telegram` from the official plugins)
2. Configure access via `/telegram:configure` with your bot token
3. Add yourself to the allowlist via `/telegram:access`
4. Keep a Claude Code session running (e.g., on a Mac Mini)

Messages you send to the bot arrive as channel events in Claude Code, which routes them to your brain MCP tools or responds directly.

### Step 8: Connect Google Calendar

1. Go to [claude.ai/settings/connectors](https://claude.ai/settings/connectors)
2. Add the Google Calendar MCP connector
3. Authorize access to your calendar

### Step 9: Create the Scheduled Life Engine Trigger

In Claude Code, use `/schedule` to create a remote trigger:

- **Cron**: `0 10,14,18,1 * * *` (runs at 6 AM, 10 AM, 2 PM, 9 PM ET — adjust UTC offsets for your timezone)
- **MCP connections**: Google Calendar, your brain-stack connector, Supabase
- **Model**: claude-sonnet-4-6
- **Prompt**: Copy the full prompt from `triggers/life-engine-prompt.md` (everything below the `---` line). Replace all `YOUR_*` placeholders with your actual values.

The trigger runs on claude.ai's infrastructure, so it works even when your Mac is off. It sends Telegram messages via the `send_telegram_message()` SQL function in your database.

### Step 10: Test Everything

In Telegram, message your bot:
- "Remember: I want to build a personal knowledge system" — should capture a thought
- "What do I know about knowledge systems?" — should search your brain
- "Add task: Set up Life Engine" — should create a task
- "List my tasks" — should show pending tasks

Wait for the next scheduled trigger fire to confirm Life Engine briefings arrive.

## How It Works

### Knowledge Capture
- **Telegram**: Message your bot naturally. Claude Code receives it, decides if it's a thought/task/question, and routes accordingly.
- **MCP**: Any Claude client (Claude.ai, Claude Code, API) can call `capture_thought` to save a thought with auto-generated embeddings and metadata.
- **Documents**: Ingest PDFs, markdown, images via Claude Code — chunks are embedded for semantic search.

### Knowledge Retrieval
- **Semantic search**: `search_thoughts` uses pgvector cosine similarity across thoughts AND document chunks.
- **Filtered listing**: `list_thoughts` with filters for type, topic, person, date range.
- **Life Engine data**: `search_facts` queries briefings, check-ins, evolution history.

### Proactive Briefings (Life Engine)
- A scheduled trigger on claude.ai fires 4x daily (morning, mid-morning, afternoon, evening).
- Each run: check time window, gather calendar + tasks + habits, compose a briefing, send via Telegram.
- Pre-meeting prep: searches your brain for context on attendees and topics before meetings.
- Logs every briefing to prevent duplicates.
- Self-improvement protocol suggests behavior changes weekly based on response patterns.

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
│       └── brain-mcp/              # MCP server edge function
│           ├── index.ts
│           ├── deno.json
│           └── .npmrc
├── skills/
│   └── life-engine/
│       └── SKILL.md                # Life Engine behavior spec (for Claude Code sessions)
└── triggers/
    └── life-engine-prompt.md       # Scheduled trigger prompt (for claude.ai remote triggers)
```

## Adding Habits

Habits are tracked in the `life_engine_habits` table. Add one via the Supabase SQL editor or through Claude:

```sql
INSERT INTO life_engine_habits (user_id, name, description, frequency, time_of_day)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Morning walk',
  '20 minutes outside before first meeting',
  'daily',
  'morning'
);
```

The Life Engine morning briefing will show habit completion status, and the evening summary will report how many you completed that day.
