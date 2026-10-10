import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type EntitySyncLogEvent =
  | 'DESIRED_PRESENT'
  | 'DESIRED_RETIRED'
  | 'SEND_CREATE'
  | 'SEND_RETIRE'
  | 'ACK'
  | 'RETRY'
  | 'FAILED'
  | 'GENERATION_BUMPED'
  | 'FULL_RESYNC'
  | 'DRIFT_REPAIR'
  | 'MANUAL_RETRY'
  | 'MANUAL_RETIRE'
  | 'MANUAL_REACTIVATE'
  | 'KERNEL_RETIRE';

@Entity('cargo_environmental_entity_logs')
export class CargoEnvironmentalEntityLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'cargo_id', type: 'uuid', nullable: true })
  cargoId!: string | null;

  @Column({ name: 'entity_name', type: 'varchar', length: 255, nullable: true })
  entityName!: string | null;

  @Column({ type: 'varchar', length: 40 })
  event!: EntitySyncLogEvent;

  @Column({ type: 'text', nullable: true })
  detail!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  payload!: unknown;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
