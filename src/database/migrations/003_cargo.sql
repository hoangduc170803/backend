-- Migration 003: Add cargos table and link to transport_requests

CREATE TYPE cargo_status_enum AS ENUM ('ACTIVE', 'DELIVERED', 'CANCELLED');

ALTER TYPE audit_entity_type_enum ADD VALUE IF NOT EXISTS 'CARGO';

CREATE TABLE IF NOT EXISTS cargos (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_code               VARCHAR(255) NOT NULL,
  source_point_id         UUID REFERENCES points(id) ON DELETE SET NULL,
  destination_location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  status                  cargo_status_enum NOT NULL DEFAULT 'ACTIVE',
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE transport_requests
  ADD COLUMN IF NOT EXISTS cargo_id UUID REFERENCES cargos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cargos_status      ON cargos(status);
CREATE INDEX IF NOT EXISTS idx_cargos_created_at  ON cargos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cargos_source      ON cargos(source_point_id);
CREATE INDEX IF NOT EXISTS idx_cargos_destination ON cargos(destination_location_id);

CREATE INDEX IF NOT EXISTS idx_transport_requests_cargo_id ON transport_requests(cargo_id);
