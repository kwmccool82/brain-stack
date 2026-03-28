-- ============================================================
-- 001_core_brain.sql
-- Core knowledge base: thoughts, documents, document chunks
-- Semantic search via pgvector embeddings (1536-dim)
-- ============================================================

-- Enable pgvector
create extension if not exists vector with schema extensions;
set search_path to public, extensions;

-- ============================================================
-- SCHEMA LOG: Migration history
-- ============================================================
create table if not exists schema_log (
  id serial primary key,
  migration_name text not null,
  description text,
  sql_executed text not null,
  executed_at timestamptz default now(),
  executed_by text default 'claude_code'
);

-- ============================================================
-- THOUGHTS: Atomic captures via MCP from any client
-- ============================================================
create table if not exists thoughts (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding vector(1536),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- ============================================================
-- DOCUMENTS: Parent record for each ingested file/URL
-- ============================================================
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  doc_type text not null,           -- pdf, markdown, image, text, url
  source_filename text,
  source_url text,
  raw_text text,
  summary text,
  metadata jsonb default '{}'::jsonb,
  chunk_count integer default 0,
  processing_status text default 'complete',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- DOCUMENT_CHUNKS: Individually embedded segments
-- ============================================================
create table if not exists document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding vector(1536),
  chunk_type text default 'text',   -- text, image_description, heading, table
  page_number integer,
  heading_path text,
  created_at timestamptz default now()
);

-- ============================================================
-- INDEXES
-- ============================================================
create index if not exists idx_thoughts_embedding
  on thoughts using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create index idx_documents_type on documents(doc_type);
create index idx_documents_created on documents(created_at desc);
create index idx_chunks_document on document_chunks(document_id);

-- NOTE: Create ivfflat index on document_chunks.embedding after inserting data:
-- CREATE INDEX idx_chunks_embedding ON document_chunks
--   USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table thoughts enable row level security;
alter table documents enable row level security;
alter table document_chunks enable row level security;
alter table schema_log enable row level security;

create policy "Service role full access" on thoughts
  for all using (auth.role() = 'service_role');
create policy "Service role full access" on documents
  for all using (auth.role() = 'service_role');
create policy "Service role full access" on document_chunks
  for all using (auth.role() = 'service_role');
create policy "Service role full access" on schema_log
  for all using (auth.role() = 'service_role');

-- ============================================================
-- SEMANTIC SEARCH: Thoughts only
-- ============================================================
create or replace function match_thoughts(
  query_embedding vector(1536),
  match_threshold float default 0.5,
  match_count int default 10,
  filter jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
language plpgsql
as $$
begin
  return query
  select
    t.id,
    t.content,
    t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- ============================================================
-- UNIFIED SEARCH: Thoughts + Document Chunks
-- ============================================================
create or replace function search_brain(
  query_embedding vector(1536),
  match_threshold float default 0.5,
  match_count int default 10
)
returns table (
  result_id uuid,
  result_type text,
  content text,
  title text,
  doc_type text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
language plpgsql
as $$
begin
  return query
  (
    select
      t.id,
      'thought'::text,
      t.content,
      null::text,
      null::text,
      t.metadata,
      1 - (t.embedding <=> query_embedding),
      t.created_at
    from thoughts t
    where 1 - (t.embedding <=> query_embedding) > match_threshold
  )
  union all
  (
    select
      dc.id,
      'document_chunk'::text,
      dc.content,
      d.title,
      d.doc_type,
      d.metadata,
      1 - (dc.embedding <=> query_embedding),
      dc.created_at
    from document_chunks dc
    join documents d on d.id = dc.document_id
    where d.processing_status = 'complete'
      and 1 - (dc.embedding <=> query_embedding) > match_threshold
  )
  order by similarity desc
  limit match_count;
end;
$$;

-- ============================================================
-- SCHEMA DISCOVERY
-- ============================================================
create or replace function describe_brain_schema()
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'tables', (
      select jsonb_agg(jsonb_build_object(
        'table', table_name,
        'columns', (
          select jsonb_agg(jsonb_build_object(
            'name', column_name,
            'type', data_type,
            'nullable', is_nullable
          ))
          from information_schema.columns c
          where c.table_name = t.table_name
            and c.table_schema = 'public'
        )
      ))
      from information_schema.tables t
      where t.table_schema = 'public'
        and t.table_name in ('thoughts', 'documents', 'document_chunks', 'schema_log')
    ),
    'stats', jsonb_build_object(
      'thought_count', (select count(*) from thoughts),
      'document_count', (select count(*) from documents),
      'chunk_count', (select count(*) from document_chunks)
    )
  ) into result;
  return result;
end;
$$;

-- Log migration
insert into schema_log (migration_name, description, sql_executed)
values (
  '001_core_brain',
  'Core brain tables: thoughts, documents, document_chunks, schema_log. Semantic search via pgvector.',
  '001_core_brain.sql'
);
