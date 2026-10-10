-- Migration 009: Zone abstraction for pickup/dropoff grouping
CREATE TYPE zone_type_enum AS ENUM ('PICKUP', 'DROPOFF');
CREATE TYPE zone_status_enum AS ENUM ('ACTIVE', 'STALE');

CREATE TABLE zones (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   VARCHAR(255) NOT NULL,
  type                   zone_type_enum NOT NULL,
  approach_location_name VARCHAR(255) NULL,
  status                 zone_status_enum NOT NULL DEFAULT 'ACTIVE',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE zone_members (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id        UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  location_name  VARCHAR(255) NOT NULL,
  position_index INT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (zone_id, location_name),
  UNIQUE (zone_id, position_index)
);
