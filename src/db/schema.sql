CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  display_name text NOT NULL,
  email text UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'reviewer', 'viewer')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  department text NOT NULL DEFAULT 'General',
  owner text NOT NULL DEFAULT 'Knowledge Admin',
  use_case text NOT NULL DEFAULT 'General Assistant',
  approval_status text NOT NULL CHECK (approval_status IN ('Draft', 'In Review', 'Approved', 'Archived')),
  current_version integer NOT NULL DEFAULT 1,
  content_text text NOT NULL DEFAULT '',
  object_key text,
  object_mime_type text,
  object_size_bytes bigint,
  object_sha256 text,
  ocr_status text NOT NULL DEFAULT 'not_required' CHECK (ocr_status IN ('not_required', 'pending', 'completed', 'failed')),
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  name text NOT NULL,
  department text NOT NULL,
  owner text NOT NULL,
  use_case text NOT NULL,
  approval_status text NOT NULL,
  content_text text NOT NULL,
  change_note text NOT NULL DEFAULT 'Document changed',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no)
);

CREATE TABLE IF NOT EXISTS approval_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  author_role text NOT NULL CHECK (author_role IN ('admin', 'reviewer', 'viewer', 'system')),
  comment_type text NOT NULL DEFAULT 'review',
  comment_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  chunk_no integer NOT NULL,
  chunk_text text NOT NULL,
  term_vector jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no, chunk_no)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  user_label text NOT NULL,
  user_department text,
  use_case text,
  question text NOT NULL,
  answer text NOT NULL,
  status text NOT NULL,
  source_document_id uuid REFERENCES documents(id),
  source_document_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (approval_status);
CREATE INDEX IF NOT EXISTS idx_documents_use_case ON documents (use_case);
CREATE INDEX IF NOT EXISTS idx_document_chunks_document ON document_chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
