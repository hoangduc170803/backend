-- Migration 001: Map records table
-- Run this once against the wes database before starting the server.

CREATE TABLE IF NOT EXISTS map_records (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  point_count     INTEGER      NOT NULL DEFAULT 0,
  path_count      INTEGER      NOT NULL DEFAULT 0,
  vehicle_count   INTEGER      NOT NULL DEFAULT 0,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  uploaded_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  uploaded_by_id  UUID         REFERENCES users(id) ON DELETE SET NULL
);
