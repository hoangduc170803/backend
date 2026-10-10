-- Rename source_location_name → source_point_name (a specific Point in the map)
ALTER TABLE cargos RENAME COLUMN source_location_name TO source_point_name;

-- Store the pickup Location name derived from the source point (used by assignment engine)
ALTER TABLE cargos ADD COLUMN IF NOT EXISTS source_pickup_location_name VARCHAR(255);
