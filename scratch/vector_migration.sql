-- Enable the pgvector extension to work with embeddings
create extension if not exists vector;

-- ──────────────────────────────────────────────────────────────────────────────
-- sop_documents: one row per uploaded policy / SOP / regulatory document
-- embedding dimension = 1536 to match gemini-embedding-2 (outputDimensionality: 1536)
-- ──────────────────────────────────────────────────────────────────────────────
alter table sop_documents add column if not exists embedding vector(1536);

create or replace function match_sop_documents (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  title text,
  doc_type text,
  summary text,
  tags text[],
  file_url text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    sop_documents.id,
    sop_documents.title,
    sop_documents.doc_type,
    sop_documents.summary,
    sop_documents.tags,
    sop_documents.file_url,
    1 - (sop_documents.embedding <=> query_embedding) as similarity
  from sop_documents
  where sop_documents.embedding is not null
    and 1 - (sop_documents.embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────────
-- sop_chunks: granular semantic chunks extracted from each document
-- Used for deep-context vector search during gap analysis
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists sop_chunks (
  id          uuid primary key default gen_random_uuid(),
  sop_id      uuid references sop_documents(id) on delete cascade,
  content     text not null,
  chapter_ref text,
  page_number int,
  embedding   vector(1536),
  created_at  timestamptz default now()
);

create index if not exists sop_chunks_embedding_idx
  on sop_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create or replace function match_sop_chunks (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
returns table (
  id          uuid,
  sop_id      uuid,
  content     text,
  chapter_ref text,
  page_number int,
  similarity  float
)
language plpgsql
as $$
begin
  return query
  select
    sop_chunks.id,
    sop_chunks.sop_id,
    sop_chunks.content,
    sop_chunks.chapter_ref,
    sop_chunks.page_number,
    1 - (sop_chunks.embedding <=> query_embedding) as similarity
  from sop_chunks
  where sop_chunks.embedding is not null
    and 1 - (sop_chunks.embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
end;
$$;
