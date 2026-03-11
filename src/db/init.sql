CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL UNIQUE,
  role VARCHAR(50) NOT NULL,
  branch VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  instruction TEXT NOT NULL,
  context TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  slack_channel VARCHAR(100),
  slack_thread_ts VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default roles
INSERT INTO roles (name, description) VALUES
  ('developer', 'Writes and reviews code, creates PRs'),
  ('designer', 'Creates UI/UX designs and design decisions'),
  ('product_manager', 'Defines requirements and priorities'),
  ('project_manager', 'Orchestrates team, reviews and merges PRs')
ON CONFLICT (name) DO NOTHING;
