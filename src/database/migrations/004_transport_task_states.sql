-- Migration 004: Add task states, cargo location name columns, and task metadata

ALTER TYPE transport_request_status_enum ADD VALUE IF NOT EXISTS 'RELEASEABLE';
ALTER TYPE transport_request_status_enum ADD VALUE IF NOT EXISTS 'READY_TO_ASSIGN';
ALTER TYPE transport_request_status_enum ADD VALUE IF NOT EXISTS 'IN_FLIGHT';
ALTER TYPE transport_request_status_enum ADD VALUE IF NOT EXISTS 'PICKUP_COMPLETED';
ALTER TYPE transport_request_status_enum ADD VALUE IF NOT EXISTS 'DELIVERY_COMPLETED';

ALTER TABLE cargos
  ADD COLUMN IF NOT EXISTS source_location_name      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS destination_location_name VARCHAR(255);

ALTER TABLE transport_requests
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
