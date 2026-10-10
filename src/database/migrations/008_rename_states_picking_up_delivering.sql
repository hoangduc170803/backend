-- Migration 008: Rename PROCESSING -> PICKING_UP, PICKUP_COMPLETED -> DELIVERING
ALTER TABLE transport_requests ALTER COLUMN status DROP DEFAULT;

ALTER TABLE transport_requests
  ALTER COLUMN status TYPE VARCHAR(50);

DROP TYPE transport_request_status_enum;

CREATE TYPE transport_request_status_enum AS ENUM (
  'CREATED',
  'READY_TO_ASSIGN',
  'PICKING_UP',
  'DELIVERING',
  'DELIVERY_COMPLETED',
  'CANCELLED',
  'FAILED'
);

UPDATE transport_requests SET status = 'PICKING_UP'  WHERE status = 'PROCESSING';
UPDATE transport_requests SET status = 'DELIVERING'  WHERE status = 'PICKUP_COMPLETED';

ALTER TABLE transport_requests
  ALTER COLUMN status TYPE transport_request_status_enum
    USING status::transport_request_status_enum;

ALTER TABLE transport_requests
  ALTER COLUMN status SET DEFAULT 'CREATED';
