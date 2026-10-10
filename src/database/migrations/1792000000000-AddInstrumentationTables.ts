import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Evaluation instrumentation (insert-only, no business logic reads them):
 *
 *   - runs: one row per experiment run, written by the scenario runner (not by
 *     WES). Metrics are cut from the transition tables by its time window.
 *   - task_status_transitions: one row per task status change (plus a birth
 *     row from NULL → CREATED), written by TransportTaskService.
 *   - sse_sessions: one row per kernel SSE (re)connect. vehicle intervals must
 *     never be computed across a session boundary — the gap is unobserved.
 *   - vehicle_state_transitions: one row per observed change of a vehicle's
 *     (position, procState, state, transportOrder), written by
 *     FleetTelemetryService in batches.
 *
 * Statuses are stored as varchar, not the transport_request_status_enum:
 * historical rows must stay readable even if the enum is renamed/extended
 * (statuses were already renamed twice — migrations 007/008).
 */
export class AddInstrumentationTables1792000000000 implements MigrationInterface {
  name = 'AddInstrumentationTables1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "runs" (
        "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "label" varchar(100) NOT NULL,
        "notes" text,
        "started_at" timestamptz NOT NULL DEFAULT now(),
        "ended_at" timestamptz
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "task_status_transitions" (
        "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "task_id" uuid NOT NULL REFERENCES "transport_requests"("id"),
        "from_status" varchar(30),
        "to_status" varchar(30) NOT NULL,
        "trigger" varchar(30),
        "vehicle_name" varchar(50),
        "reason" text,
        "context" jsonb NOT NULL DEFAULT '{}',
        "occurred_at" timestamptz NOT NULL DEFAULT now()
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tst_task"
        ON "task_status_transitions" ("task_id", "occurred_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "sse_sessions" (
        "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "connected_at" timestamptz NOT NULL DEFAULT now(),
        "ended_at" timestamptz,
        "end_reason" varchar(100)
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "vehicle_state_transitions" (
        "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "session_id" bigint NOT NULL REFERENCES "sse_sessions"("id"),
        "vehicle_name" varchar(50) NOT NULL,
        "point_name" varchar(50),
        "proc_state" varchar(30),
        "vehicle_state" varchar(30),
        "order_name" varchar(80),
        "occurred_at" timestamptz NOT NULL
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_vst_vehicle"
        ON "vehicle_state_transitions" ("vehicle_name", "occurred_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "vehicle_state_transitions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sse_sessions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "task_status_transitions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "runs"`);
  }
}
