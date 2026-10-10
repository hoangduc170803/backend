-- Migration 002: AGV records table
-- Run this once against the wes database before starting the server.

CREATE TABLE IF NOT EXISTS agvs (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL UNIQUE,
  model         VARCHAR(255),
  mac_address   VARCHAR(255),
  config        JSONB        NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by_id UUID         REFERENCES users(id) ON DELETE SET NULL
);
