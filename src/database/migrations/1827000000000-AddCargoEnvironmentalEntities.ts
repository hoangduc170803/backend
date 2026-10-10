import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCargoEnvironmentalEntities1827000000000 implements MigrationInterface {
  name = 'AddCargoEnvironmentalEntities1827000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE cargo_entity_desired_state_enum AS ENUM ('PRESENT', 'RETIRED');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE cargo_entity_sync_status_enum AS ENUM ('PENDING', 'SENDING', 'ACKED', 'RETRYING', 'FAILED');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE cargo_entity_error_kind_enum AS ENUM ('RETRYABLE', 'FATAL');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS cargo_environmental_entities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        cargo_id uuid NOT NULL,
        task_id uuid NULL,
        map_record_id uuid NULL,
        item_code varchar(255) NOT NULL,
        destination_location_name varchar(255) NULL,
        entity_name varchar(255) NOT NULL,
        generation int NOT NULL DEFAULT 1,
        desired_state cargo_entity_desired_state_enum NOT NULL,
        sync_status cargo_entity_sync_status_enum NOT NULL DEFAULT 'PENDING',
        error_kind cargo_entity_error_kind_enum NULL,
        attempt_count int NOT NULL DEFAULT 0,
        last_attempt_at timestamptz NULL,
        next_retry_at timestamptz NULL,
        acked_at timestamptz NULL,
        last_error text NULL,
        sent_envelope jsonb NULL,
        sent_pose jsonb NULL,
        last_response jsonb NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_cargo_environmental_entities_cargo UNIQUE (cargo_id),
        CONSTRAINT uq_cargo_environmental_entities_name UNIQUE (entity_name)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_cargo_environmental_entities_due
        ON cargo_environmental_entities (sync_status, next_retry_at)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS cargo_environmental_entity_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        cargo_id uuid NULL,
        entity_name varchar(255) NULL,
        event varchar(40) NOT NULL,
        detail text NULL,
        payload jsonb NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_cargo_environmental_entity_logs_cargo
        ON cargo_environmental_entity_logs (cargo_id, created_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS cargo_environmental_entity_logs`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS cargo_environmental_entities`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS cargo_entity_error_kind_enum`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS cargo_entity_sync_status_enum`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS cargo_entity_desired_state_enum`,
    );
  }
}
