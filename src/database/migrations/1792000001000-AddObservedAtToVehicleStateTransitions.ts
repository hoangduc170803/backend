import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Split the two clocks on vehicle_state_transitions:
 *
 *   - occurred_at  → host ingest time (Postgres/WES clock). Authoritative for
 *     cutting a run's [started_at, ended_at] window, because runs and
 *     task_status_transitions are stamped on the same clock.
 *   - observed_at  → kernel-side SSE timestamp (openTCS clock), nullable.
 *     Kept only for diagnostics / measuring host↔kernel skew; NEVER used to cut
 *     windows, since the kernel clock can drift minutes from the host.
 *
 * Before this, occurred_at held the (skewed) kernel time, so telemetry fell
 * outside the run window it belonged to.
 */
export class AddObservedAtToVehicleStateTransitions1792000001000 implements MigrationInterface {
  name = 'AddObservedAtToVehicleStateTransitions1792000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vehicle_state_transitions"
        ADD COLUMN IF NOT EXISTS "observed_at" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vehicle_state_transitions" DROP COLUMN IF EXISTS "observed_at"`,
    );
  }
}
