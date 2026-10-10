-- Migration 002c: Replace mac_address with VDA5050 fields on agvs table

ALTER TABLE agvs
  DROP COLUMN IF EXISTS mac_address,
  ADD COLUMN IF NOT EXISTS manufacturer  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS serial_number VARCHAR(255);
