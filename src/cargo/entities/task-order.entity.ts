import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { TransportOrderDestination } from '../../opentcs/domain/kernel-model';

export enum TaskOrderState {
  ACTIVE = 'ACTIVE',
  WITHDRAWING = 'WITHDRAWING',
  FINISHED = 'FINISHED',
  FAILED = 'FAILED',
  WITHDRAWN = 'WITHDRAWN',
  REPLACED = 'REPLACED',
  PREEMPTED = 'PREEMPTED',
}

export type TaskOrderLeg =
  | 'PICKUP'
  | 'APPROACH'
  | 'DROPOFF'
  | 'MANUAL'
  | 'PARK'
  | 'CHARGE';

@Entity('transport_request_orders')
export class TaskOrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'task_id', type: 'uuid' })
  taskId!: string;

  @Column({ type: 'int' })
  seq!: number;

  @Column({ type: 'varchar', length: 20 })
  leg!: TaskOrderLeg;

  @Column({ name: 'order_name', type: 'varchar', length: 200, unique: true })
  orderName!: string;

  @Column({ name: 'vehicle_name', type: 'varchar', length: 50, nullable: true })
  vehicleName!: string | null;

  @Column({ name: 'agv_id', type: 'uuid', nullable: true })
  agvId!: string | null;

  @Column({ type: 'jsonb', default: [] })
  destinations!: TransportOrderDestination[];

  @Column({ name: 'finished_destinations', type: 'int', default: 0 })
  finishedDestinations!: number;

  @Column({ type: 'varchar', length: 20, default: TaskOrderState.ACTIVE })
  state!: TaskOrderState;

  @Column({ name: 'kernel_state', type: 'varchar', length: 40, default: 'RAW' })
  kernelState!: string;

  @Column({ name: 'replaced_by', type: 'varchar', length: 200, nullable: true })
  replacedBy!: string | null;

  @Column({ name: 'replacement_order_id', type: 'uuid', nullable: true })
  replacementOrderId!: string | null;

  @Column({ name: 'end_reason', type: 'text', nullable: true })
  endReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt!: Date | null;
}
