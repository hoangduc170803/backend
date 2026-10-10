import type { MigrationInterface, QueryRunner } from 'typeorm';

const STATUS_VALUES = [
  'CREATED',
  'READY_TO_ASSIGN',
  'BLOCKED',
  'PICKING_UP',
  'DELIVERING',
  'DELIVERY_COMPLETED',
  'CANCELLED',
  'FAILED',
];

export class AlignSchemaWithCargoEntities1795000000000 implements MigrationInterface {
  name = 'AlignSchemaWithCargoEntities1795000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS map_records (
        id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        name              VARCHAR(255) NOT NULL,
        original_filename VARCHAR(255) NOT NULL,
        point_count       INTEGER      NOT NULL DEFAULT 0,
        path_count        INTEGER      NOT NULL DEFAULT 0,
        vehicle_count     INTEGER      NOT NULL DEFAULT 0,
        uploaded_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        uploaded_by_id    UUID         REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      ALTER TABLE cargos
        ADD COLUMN IF NOT EXISTS source_point_name           VARCHAR(255),
        ADD COLUMN IF NOT EXISTS source_pickup_location_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS destination_location_name   VARCHAR(255),
        ADD COLUMN IF NOT EXISTS deleted_at                  TIMESTAMPTZ
    `);

    await queryRunner.query(`
      ALTER TABLE agvs
        ADD COLUMN IF NOT EXISTS model            VARCHAR(255),
        ADD COLUMN IF NOT EXISTS manufacturer     VARCHAR(255),
        ADD COLUMN IF NOT EXISTS serial_number    VARCHAR(255),
        ADD COLUMN IF NOT EXISTS initial_position VARCHAR(100),
        ADD COLUMN IF NOT EXISTS config           JSONB NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS created_by_id    UUID
    `);

    const values = STATUS_VALUES.map((v) => `'${v}'`).join(', ');
    await queryRunner.query(
      `ALTER TABLE transport_requests ALTER COLUMN status DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE transport_requests ALTER COLUMN status TYPE VARCHAR(50)`,
    );
    await queryRunner.query(
      `UPDATE transport_requests SET status = 'CANCELLED' WHERE status NOT IN (${values})`,
    );
    await queryRunner.query(`DROP TYPE transport_request_status_enum`);
    await queryRunner.query(
      `CREATE TYPE transport_request_status_enum AS ENUM (${values})`,
    );
    await queryRunner.query(
      `ALTER TABLE transport_requests ALTER COLUMN status TYPE transport_request_status_enum USING status::transport_request_status_enum`,
    );
    await queryRunner.query(
      `ALTER TABLE transport_requests ALTER COLUMN status SET DEFAULT 'CREATED'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE agvs
        DROP COLUMN IF EXISTS model,
        DROP COLUMN IF EXISTS manufacturer,
        DROP COLUMN IF EXISTS serial_number,
        DROP COLUMN IF EXISTS initial_position,
        DROP COLUMN IF EXISTS config,
        DROP COLUMN IF EXISTS created_by_id`,
    );
    await queryRunner.query(
      `ALTER TABLE cargos
        DROP COLUMN IF EXISTS source_point_name,
        DROP COLUMN IF EXISTS source_pickup_location_name,
        DROP COLUMN IF EXISTS destination_location_name,
        DROP COLUMN IF EXISTS deleted_at`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS map_records`);
  }
}
