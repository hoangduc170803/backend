-- Migration 010: add soft delete support for zones
ALTER TABLE zones
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_zones_deleted_at ON zones(deleted_at);
