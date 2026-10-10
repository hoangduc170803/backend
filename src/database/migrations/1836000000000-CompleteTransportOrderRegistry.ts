import { MigrationInterface, QueryRunner } from 'typeorm';

export class CompleteTransportOrderRegistry1836000000000 implements MigrationInterface {
  name = 'CompleteTransportOrderRegistry1836000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE transport_request_orders
        ADD COLUMN IF NOT EXISTS agv_id uuid NULL,
        ADD COLUMN IF NOT EXISTS kernel_state varchar(40) NOT NULL DEFAULT 'RAW',
        ADD COLUMN IF NOT EXISTS replacement_order_id uuid NULL,
        ADD COLUMN IF NOT EXISTS started_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS finished_destinations int NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE transport_request_orders
          ADD CONSTRAINT fk_transport_request_orders_agv
          FOREIGN KEY (agv_id) REFERENCES agvs(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE transport_request_orders
          ADD CONSTRAINT fk_transport_request_orders_replacement
          FOREIGN KEY (replacement_order_id)
          REFERENCES transport_request_orders(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_transport_request_orders_agv ON transport_request_orders (agv_id, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_transport_request_orders_created ON transport_request_orders (created_at DESC, id DESC)`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_transport_request_orders_active`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_transport_request_orders_open ON transport_request_orders (state) WHERE state IN ('ACTIVE', 'WITHDRAWING')`,
    );

    // Historical rows have no order-level start timestamp. The task timestamp is the safest
    // available lower-resolution value and preserves history without inventing a new instant.
    await queryRunner.query(`
      UPDATE transport_request_orders o
      SET started_at = t.started_at
      FROM transport_requests t
      WHERE o.task_id = t.id
        AND o.started_at IS NULL
        AND t.started_at IS NOT NULL
    `);
    await queryRunner.query(`
      UPDATE transport_request_orders
      SET kernel_state = CASE state
        WHEN 'FINISHED' THEN 'FINISHED'
        WHEN 'FAILED' THEN 'FAILED'
        WHEN 'WITHDRAWN' THEN 'WITHDRAWN'
        WHEN 'REPLACED' THEN 'WITHDRAWN'
        WHEN 'PREEMPTED' THEN 'WITHDRAWN'
        ELSE kernel_state
      END
      WHERE state <> 'ACTIVE'
    `);
    await queryRunner.query(`
      UPDATE transport_request_orders old_order
      SET replacement_order_id = replacement.id
      FROM transport_request_orders replacement
      WHERE old_order.replaced_by = replacement.order_name
        AND old_order.replacement_order_id IS NULL
    `);
    await queryRunner.query(`
      UPDATE transport_request_orders o
      SET agv_id = a.id
      FROM transport_requests t, agvs a
      WHERE o.task_id = t.id
        AND o.agv_id IS NULL
        AND o.vehicle_name = a.name
        AND t.map_record_id IS NOT DISTINCT FROM a.map_record_id
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE transport_request_orders SET state = 'ACTIVE' WHERE state = 'WITHDRAWING'`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_transport_request_orders_open`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_transport_request_orders_active ON transport_request_orders (state) WHERE state = 'ACTIVE'`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_transport_request_orders_created`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_transport_request_orders_agv`,
    );
    await queryRunner.query(`
      ALTER TABLE transport_request_orders
        DROP CONSTRAINT IF EXISTS fk_transport_request_orders_replacement,
        DROP CONSTRAINT IF EXISTS fk_transport_request_orders_agv,
        DROP COLUMN IF EXISTS finished_destinations,
        DROP COLUMN IF EXISTS started_at,
        DROP COLUMN IF EXISTS replacement_order_id,
        DROP COLUMN IF EXISTS kernel_state,
        DROP COLUMN IF EXISTS agv_id
    `);
  }
}
