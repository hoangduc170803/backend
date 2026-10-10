-- Migration 002d: Add created_by_id to agvs table for TypeORM entity parity

ALTER TABLE agvs
  ADD COLUMN IF NOT EXISTS created_by_id UUID REFERENCES users(id) ON DELETE SET NULL;
