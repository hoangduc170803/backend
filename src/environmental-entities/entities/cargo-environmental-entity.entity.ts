import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { EntityEnvelope, EntityPose } from '../domain/cargo-geometry';

export enum EntityDesiredState {
  PRESENT = 'PRESENT',
  RETIRED = 'RETIRED',
}

export enum EntitySyncStatus {
  PENDING = 'PENDING',
  SENDING = 'SENDING',
  ACKED = 'ACKED',
  RETRYING = 'RETRYING',
  FAILED = 'FAILED',
}

export enum EntitySyncErrorKind {
  RETRYABLE = 'RETRYABLE',
  FATAL = 'FATAL',
}

@Entity('cargo_environmental_entities')
export class CargoEnvironmentalEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'cargo_id', type: 'uuid', unique: true })
  cargoId!: string;

  @Column({ name: 'task_id', type: 'uuid', nullable: true })
  taskId!: string | null;

  @Column({ name: 'map_record_id', type: 'uuid', nullable: true })
  mapRecordId!: string | null;

  @Column({ name: 'item_code', type: 'varchar', length: 255 })
  itemCode!: string;

  @Column({
    name: 'destination_location_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  destinationLocationName!: string | null;

  @Column({ name: 'entity_name', type: 'varchar', length: 255 })
  entityName!: string;

  @Column({ type: 'int', default: 1 })
  generation!: number;

  @Column({
    name: 'desired_state',
    type: 'enum',
    enum: EntityDesiredState,
    enumName: 'cargo_entity_desired_state_enum',
  })
  desiredState!: EntityDesiredState;

  @Column({
    name: 'sync_status',
    type: 'enum',
    enum: EntitySyncStatus,
    enumName: 'cargo_entity_sync_status_enum',
    default: EntitySyncStatus.PENDING,
  })
  syncStatus!: EntitySyncStatus;

  @Column({
    name: 'error_kind',
    type: 'enum',
    enum: EntitySyncErrorKind,
    enumName: 'cargo_entity_error_kind_enum',
    nullable: true,
  })
  errorKind!: EntitySyncErrorKind | null;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  @Column({ name: 'last_attempt_at', type: 'timestamptz', nullable: true })
  lastAttemptAt!: Date | null;

  @Column({ name: 'next_retry_at', type: 'timestamptz', nullable: true })
  nextRetryAt!: Date | null;

  @Column({ name: 'acked_at', type: 'timestamptz', nullable: true })
  ackedAt!: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ name: 'sent_envelope', type: 'jsonb', nullable: true })
  sentEnvelope!: EntityEnvelope | null;

  @Column({ name: 'sent_pose', type: 'jsonb', nullable: true })
  sentPose!: EntityPose | null;

  @Column({ name: 'last_response', type: 'jsonb', nullable: true })
  lastResponse!: unknown;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
