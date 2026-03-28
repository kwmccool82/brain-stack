import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "brain-stack",
  version: "1.0.0",
});

// Tool: Semantic Search (unified — thoughts + document chunks)
server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("search_brain", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || data.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No results found matching "${query}".` }],
        };
      }

      const results = data.map(
        (
          r: {
            result_id: string;
            result_type: string;
            content: string;
            title: string | null;
            doc_type: string | null;
            metadata: Record<string, unknown>;
            similarity: number;
            created_at: string;
          },
          i: number
        ) => {
          const m = r.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${(r.similarity * 100).toFixed(1)}% match) [${r.result_type}] ---`,
            `ID: ${r.result_id}`,
          ];
          if (r.result_type === "document_chunk" && r.title) {
            parts.push(`From: "${r.title}" (${r.doc_type})`);
          }
          parts.push(`Captured: ${new Date(r.created_at).toLocaleDateString()}`);
          if (m.type) parts.push(`Type: ${m.type}`);
          if (Array.isArray(m.topics) && m.topics.length)
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.people) && m.people.length)
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          if (Array.isArray(m.action_items) && m.action_items.length)
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          parts.push(`\n${r.content}`);
          return parts.join("\n");
        }
      );

      const thoughts = data.filter((r: { result_type: string }) => r.result_type === "thought");
      const chunks = data.filter((r: { result_type: string }) => r.result_type === "document_chunk");
      const summary = `Found ${data.length} result(s): ${thoughts.length} thought(s), ${chunks.length} document chunk(s)`;

      return {
        content: [
          {
            type: "text" as const,
            text: `${summary}\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: List Recent Thoughts
server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
    },
  },
  async ({ limit, type, topic, person, days }) => {
    try {
      let q = supabase
        .from("thoughts")
        .select("content, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }

      const { data, error } = await q;

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || !data.length) {
        return { content: [{ type: "text" as const, text: "No thoughts found." }] };
      }

      const results = data.map(
        (
          t: { content: string; metadata: Record<string, unknown>; created_at: string },
          i: number
        ) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Statistics
server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    inputSchema: {},
  },
  async () => {
    try {
      const [
        { count: thoughtCount },
        { count: docCount },
        { count: chunkCount },
        { data },
      ] = await Promise.all([
        supabase.from("thoughts").select("*", { count: "exact", head: true }),
        supabase.from("documents").select("*", { count: "exact", head: true }),
        supabase.from("document_chunks").select("*", { count: "exact", head: true }),
        supabase.from("thoughts").select("metadata, created_at").order("created_at", { ascending: false }),
      ]);

      const types: Record<string, number> = {};
      const topics: Record<string, number> = {};
      const people: Record<string, number> = {};

      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        if (Array.isArray(m.topics))
          for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
        if (Array.isArray(m.people))
          for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
      }

      const sort = (o: Record<string, number>): [string, number][] =>
        Object.entries(o)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

      const lines: string[] = [
        `Total thoughts: ${thoughtCount}`,
        `Total documents: ${docCount}`,
        `Total document chunks: ${chunkCount}`,
        `Date range: ${data?.length
          ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
          " → " +
          new Date(data[0].created_at).toLocaleDateString()
          : "N/A"
        }`,
        "",
        "Types:",
        ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
      ];

      if (Object.keys(topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
      }

      if (Object.keys(people).length) {
        lines.push("", "People mentioned:");
        for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Capture Thought
server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to the brain. Generates an embedding and extracts metadata automatically.",
    inputSchema: {
      content: z.string().describe("The thought to capture"),
      pre_extracted: z.object({
        people: z.array(z.string()).optional(),
        action_items: z.array(z.string()).optional(),
        dates_mentioned: z.array(z.string()).optional(),
        topics: z.array(z.string()).optional(),
        type: z.enum(["observation", "task", "idea", "reference", "person_note"]).optional(),
        context: z.string().optional().describe("Why this was captured"),
      }).optional().describe("Metadata extracted by the calling agent. If provided, skips auto-extraction."),
      related_to: z.array(z.string()).optional().describe("IDs of related thoughts"),
    },
  },
  async ({ content, pre_extracted, related_to }) => {
    try {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        pre_extracted
          ? Promise.resolve(pre_extracted)
          : extractMetadata(content),
      ]);

      const { error } = await supabase.from("thoughts").insert({
        content,
        embedding,
        metadata: {
          ...metadata,
          source: "mcp",
          extraction: pre_extracted ? "agent" : "auto",
          ...(related_to?.length ? { related_to } : {}),
        },
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to capture: ${error.message}` }],
          isError: true,
        };
      }

      const meta = metadata as Record<string, unknown>;
      let confirmation = `Captured as ${meta.type || "thought"}`;
      if (Array.isArray(meta.topics) && meta.topics.length)
        confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
      if (Array.isArray(meta.people) && meta.people.length)
        confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      if (Array.isArray(meta.action_items) && meta.action_items.length)
        confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;

      return {
        content: [{ type: "text" as const, text: confirmation }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Edit Thought
server.registerTool(
  "edit_thought",
  {
    title: "Edit Thought",
    description:
      "Update an existing thought's content. Re-generates embedding and metadata.",
    inputSchema: {
      id: z.string().describe("The UUID of the thought to edit"),
      content: z.string().describe("The updated thought content"),
    },
  },
  async ({ id, content }) => {
    try {
      const { data: existing, error: fetchError } = await supabase
        .from("thoughts")
        .select("id, content")
        .eq("id", id)
        .single();

      if (fetchError || !existing) {
        return {
          content: [{ type: "text" as const, text: `Thought not found: ${id}` }],
          isError: true,
        };
      }

      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const { error } = await supabase
        .from("thoughts")
        .update({
          content,
          embedding,
          metadata: { ...metadata, source: "mcp", edited: true },
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to update: ${error.message}` }],
          isError: true,
        };
      }

      const meta = metadata as Record<string, unknown>;
      let confirmation = `Updated thought ${id.slice(0, 8)}… as ${meta.type || "thought"}`;
      if (Array.isArray(meta.topics) && meta.topics.length)
        confirmation += ` — ${(meta.topics as string[]).join(", ")}`;

      return {
        content: [{ type: "text" as const, text: confirmation }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ======================
// Life Engine Tools
// ======================

// Tool: List Tasks
server.registerTool(
  "list_tasks",
  {
    title: "List Tasks",
    description: "Show pending tasks from the Life Engine task system.",
    inputSchema: {
      status: z.enum(["pending", "done", "cancelled"]).optional().default("pending"),
      priority: z.enum(["high", "normal", "low"]).optional(),
    },
  },
  async ({ status, priority }) => {
    try {
      let q = supabase.from("life_engine_tasks").select("*");
      if (status) q = q.eq("status", status);
      if (priority) q = q.eq("priority", priority);
      const { data, error } = await q.order("due_date", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false });

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
      if (!data?.length) return { content: [{ type: "text" as const, text: `No ${status || ""} tasks found.` }] };

      const lines = data.map((t: { id: string; title: string; priority: string; due_date: string | null; notes: string | null }, i: number) => {
        const icon = t.priority === "high" ? "🔴" : t.priority === "low" ? "🔵" : "🟡";
        const due = t.due_date ? ` (due ${t.due_date})` : "";
        return `${icon} ${i + 1}. ${t.title}${due}\n   ID: ${t.id}${t.notes ? `\n   ${t.notes}` : ""}`;
      });

      return { content: [{ type: "text" as const, text: `${data.length} task(s):\n\n${lines.join("\n\n")}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// Tool: Create Task
server.registerTool(
  "create_task",
  {
    title: "Create Task",
    description: "Add a new task to the Life Engine task system.",
    inputSchema: {
      title: z.string().describe("Task title"),
      priority: z.enum(["high", "normal", "low"]).optional().default("normal"),
      due_date: z.string().optional().describe("Due date YYYY-MM-DD"),
      notes: z.string().optional(),
    },
  },
  async ({ title, priority, due_date, notes }) => {
    try {
      const { data, error } = await supabase.from("life_engine_tasks").insert({
        title,
        priority,
        due_date: due_date || null,
        notes: notes || null,
      }).select("id").single();

      if (error) return { content: [{ type: "text" as const, text: `Failed to create: ${error.message}` }], isError: true };

      const icon = priority === "high" ? "🔴" : priority === "low" ? "🔵" : "🟡";
      return { content: [{ type: "text" as const, text: `${icon} Task created: ${title}${due_date ? ` (due ${due_date})` : ""}\nID: ${data.id}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// Tool: Complete Task
server.registerTool(
  "complete_task",
  {
    title: "Complete Task",
    description: "Mark a task as done by ID or by title search.",
    inputSchema: {
      id: z.string().optional().describe("Task UUID"),
      title_search: z.string().optional().describe("Partial title match"),
    },
  },
  async ({ id, title_search }) => {
    try {
      if (!id && !title_search) {
        return { content: [{ type: "text" as const, text: "Provide either id or title_search." }], isError: true };
      }

      if (id) {
        const { error } = await supabase.from("life_engine_tasks")
          .update({ status: "done", completed_at: new Date().toISOString() })
          .eq("id", id);
        if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Done: ${id}` }] };
      }

      const { data, error } = await supabase.from("life_engine_tasks")
        .select("id, title")
        .eq("status", "pending")
        .ilike("title", `%${title_search}%`);

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
      if (!data?.length) return { content: [{ type: "text" as const, text: `No pending task matching "${title_search}".` }] };
      if (data.length > 1) {
        const matches = data.map((t: { id: string; title: string }) => `- ${t.title} (${t.id})`).join("\n");
        return { content: [{ type: "text" as const, text: `Multiple matches:\n${matches}` }] };
      }

      const { error: updateErr } = await supabase.from("life_engine_tasks")
        .update({ status: "done", completed_at: new Date().toISOString() })
        .eq("id", data[0].id);
      if (updateErr) return { content: [{ type: "text" as const, text: `Error: ${updateErr.message}` }], isError: true };
      return { content: [{ type: "text" as const, text: `Done: ${data[0].title}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// Tool: Get Schedule
server.registerTool(
  "get_schedule",
  {
    title: "Get Schedule",
    description: "Get today's pending tasks and recent briefings.",
    inputSchema: {
      date: z.string().optional().describe("Date YYYY-MM-DD. Defaults to today."),
    },
  },
  async ({ date }) => {
    try {
      const targetDate = date || new Date().toISOString().split("T")[0];

      const [tasksRes, briefingsRes, checkinsRes] = await Promise.all([
        supabase.from("life_engine_tasks").select("*").eq("status", "pending").order("priority").order("due_date", { ascending: true, nullsFirst: false }),
        supabase.from("life_engine_briefings").select("briefing_type, content, created_at").gte("created_at", `${targetDate}T00:00:00`).lte("created_at", `${targetDate}T23:59:59`).order("created_at"),
        supabase.from("life_engine_checkins").select("checkin_type, value, notes, created_at").gte("created_at", `${targetDate}T00:00:00`).lte("created_at", `${targetDate}T23:59:59`),
      ]);

      const parts: string[] = [`Life Engine Snapshot — ${targetDate}`];

      const tasks = tasksRes.data || [];
      if (tasks.length) {
        const taskLines = tasks.map((t: { title: string; priority: string; due_date: string | null }) => {
          const icon = t.priority === "high" ? "🔴" : t.priority === "low" ? "🔵" : "🟡";
          const due = t.due_date ? ` (due ${t.due_date})` : "";
          return `  ${icon} ${t.title}${due}`;
        });
        parts.push(`\nPending tasks (${tasks.length}):\n${taskLines.join("\n")}`);
      } else {
        parts.push("\nNo pending tasks.");
      }

      const briefings = briefingsRes.data || [];
      if (briefings.length) {
        parts.push(`\nBriefings sent today: ${briefings.map((b: { briefing_type: string }) => b.briefing_type).join(", ")}`);
      }

      const checkins = checkinsRes.data || [];
      if (checkins.length) {
        parts.push(`\nCheck-ins: ${checkins.map((c: { value: string }) => c.value).join(", ")}`);
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// Tool: Search Facts
server.registerTool(
  "search_facts",
  {
    title: "Search Life Engine Facts",
    description: "Search across Life Engine tables — briefings, check-ins, evolution, tasks.",
    inputSchema: {
      table: z.enum(["briefings", "checkins", "evolution", "tasks"]).describe("Which table to query"),
      days: z.number().optional().default(7),
      limit: z.number().optional().default(20),
    },
  },
  async ({ table, days, limit }) => {
    try {
      const tableName = `life_engine_${table}`;
      const since = new Date(Date.now() - days * 86400000).toISOString();

      const { data, error } = await supabase
        .from(tableName)
        .select("*")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
      if (!data?.length) return { content: [{ type: "text" as const, text: `No ${table} entries in the last ${days} days.` }] };

      return { content: [{ type: "text" as const, text: `${data.length} ${table} entries (last ${days} days):\n\n${JSON.stringify(data, null, 2)}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// Tool: Get Taste Preferences
server.registerTool(
  "get_taste_preferences",
  {
    title: "Get Taste Preferences",
    description:
      "Retrieve interaction preferences — standards for communication style, work approach, and tone calibration.",
    inputSchema: {
      domain: z.string().optional().describe("Filter by domain (e.g. 'communication', 'work')"),
    },
  },
  async ({ domain }) => {
    try {
      let q = supabase
        .from("taste_preferences")
        .select("*")
        .order("domain")
        .order("preference_name");

      if (domain) q = q.ilike("domain", `%${domain}%`);

      const { data, error } = await q;

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || !data.length) {
        return { content: [{ type: "text" as const, text: domain ? `No preferences found for domain "${domain}".` : "No taste preferences found." }] };
      }

      const results = data.map(
        (p: { preference_name: string; domain: string | null; want: string | null; reject: string | null; constraint_type: string | null }) => {
          const parts = [`${p.preference_name}${p.domain ? ` [${p.domain}]` : ""}`];
          if (p.want) parts.push(`  Want: ${p.want}`);
          if (p.reject) parts.push(`  Reject: ${p.reject}`);
          if (p.constraint_type) parts.push(`  Type: ${p.constraint_type}`);
          return parts.join("\n");
        }
      );

      return {
        content: [{
          type: "text" as const,
          text: `${data.length} preference(s):\n\n${results.join("\n\n")}`,
        }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// --- Hono App with Auth ---

const app = new Hono();

app.all("*", async (c) => {
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
