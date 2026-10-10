-- Migration 006: add soft delete support for cargos
ALTER TABLE cargos
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_cargos_deleted_at ON cargos(deleted_at);
