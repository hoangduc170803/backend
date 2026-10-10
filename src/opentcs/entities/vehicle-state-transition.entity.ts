import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Insert-only log of observed vehicle state changes (position / procState /
 * state / transport order), one row per change, batched by
 * FleetTelemetryService. Previous state is NOT stored: every metric over this
 * table is an interval metric, computed with LEAD()/LAG() partitioned by
 * (vehicle_name, session_id) so intervals never span an SSE reconnect gap.
 */
@Entity('vehicle_state_transitions')
export class VehicleStateTransitionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'session_id', type: 'bigint' })
  sessionId!: string;

  @Column({ name: 'vehicle_name', type: 'varchar', length: 50 })
  vehicleName!: string;

  /** Current point; null while between points or unknown. */
  @Column({ name: 'point_name', type: 'varchar', length: 50, nullable: true })
  pointName!: string | null;

  @Column({ name: 'proc_state', type: 'varchar', length: 30, nullable: true })
  procState!: string | null;

  @Column({
    name: 'vehicle_state',
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  vehicleState!: string | null;

  @Column({ name: 'order_name', type: 'varchar', length: 80, nullable: true })
  orderName!: string | null;

  @Column({
    name: 'goal_order_name',
    type: 'varchar',
    length: 80,
    nullable: true,
  })
  goalOrderName!: string | null;

  @Column({ name: 'order_created_at', type: 'timestamptz', nullable: true })
  orderCreatedAt!: Date | null;

  @Column({ name: 'goal_received_at', type: 'timestamptz', nullable: true })
  goalReceivedAt!: Date | null;

  /**
   * Host ingest time (WES/Postgres clock). Authoritative for cutting a run's
   * time window — the same clock as runs / task_status_transitions.
   */
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  /**
   * Kernel-side SSE timestamp (openTCS clock), null when the payload carries
   * none. Diagnostics only (host↔kernel skew) — never used for windowing,
   * since the kernel clock can drift from the host.
   */
  @Column({ name: 'observed_at', type: 'timestamptz', nullable: true })
  observedAt!: Date | null;

  /** Map loaded in openTCS when this row was recorded; NULL for rows older than migration 1829. */
  @Column({ name: 'map_record_id', type: 'uuid', nullable: true })
  mapRecordId!: string | null;
}
