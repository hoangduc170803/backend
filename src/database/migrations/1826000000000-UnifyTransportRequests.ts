import { MigrationInterface, QueryRunner } from 'typeorm';

export class UnifyTransportRequests1826000000000 implements MigrationInterface {
  name = 'UnifyTransportRequests1826000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE transport_request_kind_enum AS ENUM ('CARGO', 'MANUAL', 'PARK', 'CHARGE');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(
      `ALTER TABLE transport_requests ADD COLUMN IF NOT EXISTS kind transport_request_kind_enum NOT NULL DEFAULT 'CARGO'`,
    );
    await queryRunner.query(
      `ALTER TYPE transport_request_status_enum ADD VALUE IF NOT EXISTS 'EXECUTING'`,
    );
    await queryRunner.query(
      `ALTER TYPE transport_request_status_enum ADD VALUE IF NOT EXISTS 'COMPLETED'`,
    );
    await queryRunner.query(
      `ALTER TYPE cargo_status_enum ADD VALUE IF NOT EXISTS 'FAILED'`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS transport_request_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id uuid NOT NULL REFERENCES transport_requests(id) ON DELETE CASCADE,
        seq int NOT NULL,
        leg varchar(20) NOT NULL,
        order_name varchar(200) NOT NULL UNIQUE,
        vehicle_name varchar(50) NULL,
        destinations jsonb NOT NULL DEFAULT '[]',
        state varchar(20) NOT NULL DEFAULT 'ACTIVE',
        replaced_by varchar(200) NULL,
        end_reason text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_transport_request_orders_task ON transport_request_orders (task_id, seq)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_transport_request_orders_active ON transport_request_orders (state) WHERE state = 'ACTIVE'`,
    );

    await queryRunner.query(`
      INSERT INTO transport_request_orders (task_id, seq, leg, order_name, vehicle_name, state, created_at, ended_at)
      SELECT t.id, legs.seq, legs.leg, legs.order_name, t.metadata->>'assignedVehicleName',
             CASE WHEN t.status IN ('DELIVERY_COMPLETED', 'CANCELLED', 'FAILED') THEN 'FINISHED' ELSE 'ACTIVE' END,
             t.created_at,
             CASE WHEN t.status IN ('DELIVERY_COMPLETED', 'CANCELLED', 'FAILED') THEN t.updated_at END
      FROM transport_requests t
      CROSS JOIN LATERAL (VALUES
        (1, 'PICKUP', t.metadata->>'pickupOrderName'),
        (2, 'APPROACH', t.metadata->>'approachOrderName'),
        (3, 'DROPOFF', t.metadata->>'dropoffOrderName')
      ) AS legs(seq, leg, order_name)
      WHERE legs.order_name IS NOT NULL
      ON CONFLICT (order_name) DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS transport_request_orders`);
    await queryRunner.query(
      `DELETE FROM transport_requests WHERE kind <> 'CARGO'`,
    );
    await queryRunner.query(
      `ALTER TABLE transport_requests DROP COLUMN IF EXISTS kind`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS transport_request_kind_enum`);
  }
}
