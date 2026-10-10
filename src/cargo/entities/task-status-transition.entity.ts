import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Insert-only audit row for every transport task status change (plus a birth
 * row with fromStatus = null when the task is created). Written exclusively by
 * TransportTaskService; nothing in the dispatch path ever reads it — it exists
 * for offline evaluation (flow time, wait-to-assign, preempt counts, …).
 */
@Entity('task_status_transitions')
export class TaskStatusTransitionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'task_id', type: 'uuid' })
  taskId!: string;

  /** Null only on the birth row. Stored as varchar so history survives enum renames. */
  @Column({ name: 'from_status', type: 'varchar', length: 30, nullable: true })
  fromStatus!: string | null;

  @Column({ name: 'to_status', type: 'varchar', length: 30 })
  toStatus!: string;

  /** Which engine caused the change: API | RELEASE_ENGINE | ASSIGNMENT_ENGINE | SAGA. */
  @Column({ type: 'varchar', length: 30, nullable: true })
  trigger!: string | null;

  /** Snapshot of the assigned vehicle at transition time (metadata is mutable). */
  @Column({ name: 'vehicle_name', type: 'varchar', length: 50, nullable: true })
  vehicleName!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  /** Free-form measurements: distanceToSource at assign, withdrawn order on preempt, … */
  @Column({ type: 'jsonb', default: {} })
  context!: Record<string, unknown>;

  @Column({
    name: 'occurred_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  occurredAt!: Date;
}
