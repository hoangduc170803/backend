import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type VehicleErrorEventKind =
  | 'RAISED'
  | 'CHANGED'
  | 'CLEARED'
  | 'RECOVERY_ATTEMPTED'
  | 'RECOVERY_REFUSED';

@Entity('vehicle_error_events')
@Index(['vehicleName', 'occurredAt'])
export class VehicleErrorEventEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'vehicle_name', type: 'varchar', length: 50 })
  vehicleName!: string;

  @Column({ name: 'kind', type: 'varchar', length: 30 })
  kind!: VehicleErrorEventKind;

  @Column({ name: 'fatal_error_types', type: 'jsonb', default: () => "'[]'" })
  fatalErrorTypes!: string[];

  @Column({ name: 'warning_error_types', type: 'jsonb', default: () => "'[]'" })
  warningErrorTypes!: string[];

  @Column({ name: 'vehicle_state', type: 'varchar', length: 30 })
  vehicleState!: string;

  @Column({ name: 'point_name', type: 'varchar', length: 50, nullable: true })
  pointName!: string | null;

  @Column({
    name: 'transport_order_name',
    type: 'varchar',
    length: 80,
    nullable: true,
  })
  transportOrderName!: string | null;

  @Column({ name: 'metadata', type: 'jsonb', default: () => "'{}'" })
  metadata!: Record<string, unknown>;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ name: 'observed_at', type: 'timestamptz', nullable: true })
  observedAt!: Date | null;

  /** Map loaded in openTCS when this row was recorded; NULL for rows older than migration 1829. */
  @Column({ name: 'map_record_id', type: 'uuid', nullable: true })
  mapRecordId!: string | null;
}
