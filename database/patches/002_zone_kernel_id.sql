-- Patch 002: add kernel_id to zones table
-- Run this once on any existing database that already has the zones table.

CREATE SEQUENCE IF NOT EXISTS zone_kernel_id_seq START 1;

ALTER TABLE zones
  ADD COLUMN IF NOT EXISTS kernel_id INTEGER UNIQUE;
