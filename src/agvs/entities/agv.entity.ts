import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('agvs')
export class AgvEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 100 })
  code!: string;

  @Column({ length: 100 })
  name!: string;

  @Column({ nullable: true, type: 'varchar' })
  model!: string | null;

  @Column({ nullable: true, type: 'varchar' })
  manufacturer!: string | null;

  @Column({ name: 'serial_number', nullable: true, type: 'varchar' })
  serialNumber!: string | null;

  @Column({ name: 'is_dispatch_enabled', default: true })
  isDispatchEnabled!: boolean;

  @Column({ name: 'is_ignored', default: false })
  isIgnored!: boolean;

  @Column({
    name: 'critical_battery_threshold',
    type: 'smallint',
    default: 35,
  })
  criticalBatteryThreshold!: number;

  @Column({
    name: 'sufficient_battery_threshold',
    type: 'smallint',
    default: 60,
  })
  sufficientBatteryThreshold!: number;

  @Column({
    name: 'good_battery_threshold',
    type: 'smallint',
    default: 50,
  })
  goodBatteryThreshold!: number;

  @Column({
    name: 'full_battery_threshold',
    type: 'smallint',
    default: 95,
  })
  fullBatteryThreshold!: number;

  @Column({
    name: 'initial_position',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  initialPosition!: string | null;

  @Column({ type: 'jsonb', default: {} })
  config!: Record<string, unknown>;

  /**
   * openTCS plant model name reported by the kernel at creation time. Kept as display metadata
   * only — a name can be shared by more than one uploaded map record, so it is never used to
   * decide which map this AGV belongs to. See `ZoneEntity.plantModelName` for the same split.
   */
  @Column({
    name: 'plant_model_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  plantModelName!: string | null;

  /** The `map_records` row this AGV was registered under — the authoritative "which map does
   *  this belong to" (see `ZoneEntity.mapRecordId`). NULL for AGVs created before map scoping,
   *  or while no map record could be resolved for the kernel's currently loaded model. */
  @Column({ name: 'map_record_id', type: 'uuid', nullable: true })
  mapRecordId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'created_by_id', type: 'uuid', nullable: true })
  createdById!: string | null;
}
