import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AGV names repeat across maps, so a vehicle's state log and error events must remember which
 * map was loaded when they were recorded. Rows written before this migration stay NULL — they
 * cannot be attributed after the fact, and the history screens keep showing them as legacy.
 */
export class ScopeVehicleHistoryToMapRecord1829000000000 implements MigrationInterface {
  name = 'ScopeVehicleHistoryToMapRecord1829000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE vehicle_state_transitions
        ADD COLUMN IF NOT EXISTS map_record_id uuid NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_vehicle_state_transitions_map_vehicle
        ON vehicle_state_transitions (map_record_id, vehicle_name, occurred_at)
    `);
    await queryRunner.query(`
      ALTER TABLE vehicle_error_events
        ADD COLUMN IF NOT EXISTS map_record_id uuid NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_vehicle_error_events_map_vehicle
        ON vehicle_error_events (map_record_id, vehicle_name, occurred_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_vehicle_error_events_map_vehicle`,
    );
    await queryRunner.query(
      `ALTER TABLE vehicle_error_events DROP COLUMN IF EXISTS map_record_id`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_vehicle_state_transitions_map_vehicle`,
    );
    await queryRunner.query(
      `ALTER TABLE vehicle_state_transitions DROP COLUMN IF EXISTS map_record_id`,
    );
  }
}
