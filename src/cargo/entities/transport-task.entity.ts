import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { OrderRecreationBudget } from '../domain/order-recreation';

export enum TaskStatus {
  CREATED = 'CREATED',
  READY_TO_ASSIGN = 'READY_TO_ASSIGN',
  BLOCKED = 'BLOCKED',
  PICKING_UP = 'PICKING_UP',
  DELIVERING = 'DELIVERING',
  DELIVERY_COMPLETED = 'DELIVERY_COMPLETED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
  EXECUTING = 'EXECUTING',
  COMPLETED = 'COMPLETED',
}

export enum TaskKind {
  CARGO = 'CARGO',
  MANUAL = 'MANUAL',
  PARK = 'PARK',
  CHARGE = 'CHARGE',
}

export interface PendingDropoff {
  slot: string;
  zoneId: string;
  waitFor: string;
  since: string;
}

export interface PendingTaskOrder {
  kind: string;
  vehicleName: string | null;
  aimedAt: string;
  destinations: { locationName: string; operation: string }[];
  dispensable?: boolean;
  type?: string;
}

export interface TaskMetadata {
  assignedVehicleName?: string;
  pendingDropoff?: PendingDropoff;
  pickupOrderName?: string;
  approachOrderName?: string;
  dropoffOrderName?: string;
  approachedAt?: string;
  approachPointName?: string;
  retreatPointName?: string;
  unloadedAt?: string;
  blockedReason?: string;
  swapCount?: number;
  orderRecreation?: OrderRecreationBudget;
  replacingOrderName?: string;
  cancelReason?: string;
  pendingOrder?: PendingTaskOrder;
}

@Entity('transport_requests')
export class TransportTaskEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'request_code', type: 'varchar', length: 50, unique: true })
  requestCode!: string;

  @Column({ name: 'cargo_id', type: 'uuid', nullable: true })
  cargoId!: string | null;

  @Column({
    type: 'enum',
    enum: TaskKind,
    enumName: 'transport_request_kind_enum',
    default: TaskKind.CARGO,
  })
  kind!: TaskKind;

  @Column({ name: 'map_record_id', type: 'uuid', nullable: true })
  mapRecordId!: string | null;

  @Column({
    type: 'enum',
    enum: TaskStatus,
    enumName: 'transport_request_status_enum',
    default: TaskStatus.CREATED,
  })
  status!: TaskStatus;

  @Column({ type: 'jsonb', default: {} })
  metadata!: TaskMetadata;

  @Column({ name: 'assigned_at', type: 'timestamptz', nullable: true })
  assignedAt!: Date | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
