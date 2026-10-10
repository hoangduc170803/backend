import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGoalTimingToVehicleTransitions1803000000000 implements MigrationInterface {
  name = 'AddGoalTimingToVehicleTransitions1803000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vehicle_state_transitions"
        ADD COLUMN IF NOT EXISTS "goal_order_name" varchar(80),
        ADD COLUMN IF NOT EXISTS "order_created_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "goal_received_at" timestamptz`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_vst_goal_order"
        ON "vehicle_state_transitions" ("goal_order_name", "goal_received_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_vst_goal_order"`);
    await queryRunner.query(
      `ALTER TABLE "vehicle_state_transitions"
        DROP COLUMN IF EXISTS "goal_received_at",
        DROP COLUMN IF EXISTS "order_created_at",
        DROP COLUMN IF EXISTS "goal_order_name"`,
    );
  }
}
