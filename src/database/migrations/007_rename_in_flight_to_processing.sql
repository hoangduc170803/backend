-- Migration 007: Rename task status IN_FLIGHT -> PROCESSING
ALTER TYPE transport_request_status_enum ADD VALUE IF NOT EXISTS 'PROCESSING';

UPDATE transport_requests SET status = 'PROCESSING' WHERE status = 'IN_FLIGHT';

-- Remove old value by recreating the type without IN_FLIGHT
ALTER TABLE transport_requests ALTER COLUMN status DROP DEFAULT;

ALTER TABLE transport_requests
  ALTER COLUMN status TYPE VARCHAR(50);

DROP TYPE transport_request_status_enum;

CREATE TYPE transport_request_status_enum AS ENUM (
  'CREATED',
  'READY_TO_ASSIGN',
  'PROCESSING',
  'PICKUP_COMPLETED',
  'DELIVERY_COMPLETED',
  'CANCELLED',
  'FAILED'
);

ALTER TABLE transport_requests
  ALTER COLUMN status TYPE transport_request_status_enum
    USING status::transport_request_status_enum;

ALTER TABLE transport_requests
  ALTER COLUMN status SET DEFAULT 'CREATED';
