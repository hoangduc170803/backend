import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum CargoStatus {
  ACTIVE = 'ACTIVE',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

@Entity('cargos')
export class CargoEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'item_code', length: 255 })
  itemCode!: string;

  @Column({
    name: 'source_point_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  sourcePointName!: string | null;

  @Column({
    name: 'source_pickup_location_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  sourcePickupLocationName!: string | null;

  @Column({
    name: 'destination_location_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  destinationLocationName!: string | null;

  @Column({
    name: 'reserved_location_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  reservedLocationName!: string | null;

  @Column({ name: 'slot_decision_seq', type: 'int', default: 0 })
  slotDecisionSeq!: number;

  @Column({ name: 'source_zone_id', type: 'uuid', nullable: true })
  sourceZoneId!: string | null;

  @Column({ name: 'destination_zone_id', type: 'uuid', nullable: true })
  destinationZoneId!: string | null;

  /** The `map_records` row active when this cargo was created — stamped once, denormalized so
   *  the cargo's map identity survives its source/destination `ZoneEntity` being deleted later
   *  (zones may be removed once no cargo is actively in flight through them; see
   *  `OperatingAreasService.remove`). Authoritative for "which map does this cargo belong to" —
   *  same split as `ZoneEntity.mapRecordId`. NULL for cargo created before map scoping. */
  @Column({ name: 'map_record_id', type: 'uuid', nullable: true })
  mapRecordId!: string | null;

  @Column({
    type: 'enum',
    enum: CargoStatus,
    enumName: 'cargo_status_enum',
    default: CargoStatus.ACTIVE,
  })
  status!: CargoStatus;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
