-- Migration 002b: Add missing columns to agvs table (if created without them)

ALTER TABLE agvs
  ADD COLUMN IF NOT EXISTS model       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS mac_address VARCHAR(255),
  ADD COLUMN IF NOT EXISTS config      JSONB NOT NULL DEFAULT '{}';
