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
| **OpenRouter API key** | Generates vector embeddings for semantic search (text-embedding-3-small) and fallback metadata extraction (gpt-4o-mini) — runs inside the brain MCP edge function | Pay-per-use, ~$5 to start |
| **Telegram account** | Create a bot for Life Engine notifications and conversational input | Free |
| **Google account** | Calendar integration for meeting prep and briefings | Free |
| **A Mac that stays on** | Claude Code runs continuously to handle Telegram messages | Any Mac (Mini recommended) |

## Setup

### Step 1: Create a Supabase Project

**What**: Supabase is your database — it stores every thought you capture, every task you create, every briefing the Life Engine sends. It also hosts the brain MCP edge function that Claude talks to.

**Why**: You need a persistent store that Claude can read/write from any client (Claude.ai, Claude Code, scheduled triggers). Supabase gives you a Postgres database with pgvector for semantic search, edge functions for the MCP server, and pg_net for sending Telegram messages directly from SQL.

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Note your **project ref** (in the URL: `supabase.com/project/YOUR_PROJECT_REF`)
3. Go to Settings > API and copy:
   - **Project URL** (e.g., `https://YOUR_PROJECT_REF.supabase.co`)
   - **Service Role Key** (under "service_role", not "anon")

### Step 2: Run Schema Migrations

**What**: These SQL files create the tables, indexes, search functions, and helper functions that power the brain and Life Engine.

**Why**: The brain needs tables for thoughts and documents with vector columns for semantic search. The Life Engine needs tables for tasks, habits, briefings, and check-ins to track your day and avoid sending duplicate messages.

In the Supabase SQL Editor, run each file in order:

1. `schema/001_core_brain.sql` — Creates the `thoughts`, `documents`, and `document_chunks` tables with pgvector embeddings. Also creates `search_brain()`, a unified semantic search function that queries across both thoughts and document chunks.
2. `schema/002_life_engine.sql` — Creates the Life Engine tables: `life_engine_tasks` (your to-do list), `life_engine_habits` + `life_engine_habit_log` (habit tracking), `life_engine_briefings` (log of every message sent, used for dedup), `life_engine_checkins` (mood/energy check-ins), and `life_engine_evolution` (self-improvement suggestions).
3. `schema/003_telegram_helper.sql` — Creates `send_telegram_message()`, a Postgres function that sends Telegram messages via HTTP using pg_net. This is how the scheduled trigger delivers briefings without needing a local Telegram plugin. **Edit the bot token and chat ID before running.**
4. `schema/004_heartbeat_watchdog.sql` — *Optional.* Creates a pg_cron job that checks every 5 minutes whether the Life Engine is still running. If no heartbeat in 90 minutes during waking hours, it alerts you via Telegram. **Edit the bot token and chat ID before running.**

### Step 3: Get an OpenRouter API Key

**What**: OpenRouter provides the embedding model that converts text into vectors for semantic search.

**Why**: When you capture a thought, the brain MCP server needs to convert it into a 1536-dimensional vector so it can be found later via similarity search. When you search, your query is also embedded and compared against stored vectors. OpenRouter routes these requests to OpenAI's text-embedding-3-small model. It also provides gpt-4o-mini for automatic metadata extraction (people, topics, action items) as a fallback — though Claude Code typically handles extraction itself.

1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Create an API key
3. Add credits ($5 is plenty to start — embeddings cost ~$0.02 per million tokens)

### Step 4: Deploy the Brain MCP Edge Function

**What**: The brain MCP server is a Supabase Edge Function that exposes your knowledge base as MCP tools — `capture_thought`, `search_thoughts`, `list_tasks`, `create_task`, etc.

**Why**: MCP (Model Context Protocol) is how Claude connects to external data sources. By deploying your brain as an MCP server, any Claude client — Claude.ai in the browser, Claude Code in the terminal, or a scheduled trigger in the cloud — can read and write to your knowledge base using the same tools.

```bash
# Install Supabase CLI if you haven't
npm install -g supabase

# Set secrets on your project
supabase secrets set --project-ref YOUR_PROJECT_REF \
  OPENROUTER_API_KEY=your-key \
  MCP_ACCESS_KEY=$(openssl rand -hex 32)

# Deploy (--no-verify-jwt is required for MCP connectors to call it)
supabase functions deploy brain-mcp --use-api --project-ref YOUR_PROJECT_REF --no-verify-jwt
```

Note your `MCP_ACCESS_KEY` — you need it for the next step. This key protects your brain from unauthorized access.

Your MCP server is now live at:
```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/brain-mcp?key=YOUR_MCP_ACCESS_KEY
```

### Step 5: Connect Brain MCP to Claude.ai

**What**: Register your brain MCP server as a connector in Claude.ai so Claude can use your brain tools.

**Why**: Scheduled triggers run on claude.ai's infrastructure, not on your Mac. They need a cloud-accessible MCP connector to reach your brain. This step also makes your brain available in Claude.ai web conversations.

1. Go to [claude.ai/settings/connectors](https://claude.ai/settings/connectors)
2. Add a new MCP connector with the URL from Step 4
3. Name it something like "brain-stack"

This gives Claude.ai (and scheduled triggers) access to your brain tools: `capture_thought`, `search_thoughts`, `list_tasks`, etc.

You can also add it to Claude Code's local MCP config for direct access:
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

**What**: A Telegram bot that serves as your primary interface — you message it to interact with your brain, and it messages you with Life Engine briefings.

**Why**: Telegram is the communication layer. You text the bot naturally ("remember this", "what's on my schedule", "add task: finish report"). Claude Code receives these messages via the Telegram plugin and routes them. The Life Engine also sends proactive briefings to this bot via the `send_telegram_message()` SQL function.

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
You should receive a Telegram message within a few seconds.

### Step 7: Set Up Telegram Plugin in Claude Code

**What**: Install the Telegram plugin in Claude Code so it can receive and respond to your bot messages.

**Why**: The Telegram plugin turns Claude Code into a live responder. When you message your bot, the message arrives as a "channel event" in Claude Code. Claude reads it, decides what to do (capture a thought, search, create a task, answer a question), and replies through the bot. Without this, your bot is one-way only (Life Engine can send, but you can't interact).

1. Install the Telegram plugin in Claude Code (it's `plugin:telegram` from the official plugins)
2. Configure access via `/telegram:configure` with your bot token
3. Add yourself to the allowlist via `/telegram:access`
4. Keep a Claude Code session running (e.g., on a Mac Mini)

Messages you send to the bot arrive as channel events in Claude Code, which routes them to your brain MCP tools or responds directly.

### Step 8: Connect Google Calendar

**What**: Add the Google Calendar MCP connector so Claude can read your schedule.

**Why**: The Life Engine needs your calendar to generate morning briefings ("you have 5 meetings today"), pre-meeting prep ("meeting with X in 30 min, here's context from your brain"), and evening summaries ("tomorrow starts with Y"). Without calendar access, the Life Engine can only surface tasks and habits.

1. Go to [claude.ai/settings/connectors](https://claude.ai/settings/connectors)
2. Add the Google Calendar MCP connector
3. Authorize access to your calendar

### Step 9: Create the Scheduled Life Engine Trigger

**What**: A scheduled remote trigger on claude.ai that fires 4x daily and sends you proactive briefings via Telegram.

**Why**: The Life Engine is what makes this system proactive instead of reactive. Instead of you always asking Claude for information, it checks your calendar, tasks, and habits on a schedule and pushes relevant context to you. It runs on claude.ai's cloud infrastructure (not your Mac), so it works even if your Claude Code session is down. It sends Telegram messages via the `send_telegram_message()` SQL function in your database, bypassing the need for a local Telegram plugin.

In Claude Code, use `/schedule` to create a remote trigger:

- **Cron**: `0 10,14,18,1 * * *` (runs at 6 AM, 10 AM, 2 PM, 9 PM ET — adjust UTC offsets for your timezone)
- **MCP connections**: Google Calendar, your brain-stack connector, Supabase
- **Model**: claude-sonnet-4-6
- **Prompt**: Copy the full prompt from `triggers/life-engine-prompt.md` (everything below the `---` line). Replace all `YOUR_*` placeholders with your actual values.

The trigger needs three MCP connections:
1. **Google Calendar** — to read your schedule
2. **brain-stack** (your MCP connector from Step 5) — to search thoughts, list tasks, check habits
3. **Supabase** — to run SQL directly (send Telegram messages, query/log briefings, check habits)

### Step 10: Test Everything

**What**: Verify the full pipeline works end-to-end.

**Why**: There are several moving parts (Supabase, MCP, Telegram plugin, scheduled triggers). Testing each interaction confirms the wiring is correct.

In Telegram, message your bot:
- "Remember: I want to build a personal knowledge system" — should capture a thought via brain MCP
- "What do I know about knowledge systems?" — should semantic search your brain and return results
- "Add task: Set up Life Engine" — should create a task in life_engine_tasks
- "List my tasks" — should show pending tasks

Then test the scheduled trigger:
- In Claude Code, use `/schedule` and select "Run Now" for your Life Engine trigger
- You should receive a Telegram briefing within 2-5 minutes
- Check that it includes your calendar, tasks, and habits

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
