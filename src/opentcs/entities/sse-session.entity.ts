import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One row per kernel SSE (re)connect, opened/closed by FleetTelemetryService.
 * Vehicle state intervals must never be computed across two sessions: the gap
 * between them is unobserved time, not "the vehicle stood still". Analysis
 * therefore always partitions vehicle_state_transitions by session_id.
 */
@Entity('sse_sessions')
export class SseSessionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({
    name: 'connected_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  connectedAt!: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt!: Date | null;

  @Column({ name: 'end_reason', type: 'varchar', length: 100, nullable: true })
  endReason!: string | null;
}
