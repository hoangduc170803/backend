import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ZoneMemberEntity } from './zone-member.entity';

export enum ZoneType {
  PICKUP = 'PICKUP',
  DROPOFF = 'DROPOFF',
}

export enum ZoneStatus {
  ACTIVE = 'ACTIVE',
  STALE = 'STALE',
}

@Entity('zones')
export class ZoneEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'enum', enum: ZoneType, enumName: 'zone_type_enum' })
  type!: ZoneType;

  /** Hex color (#RRGGBB) used to render the zone's slots on the map. */
  @Column({ type: 'varchar', length: 9, nullable: true })
  color!: string | null;

  /** Kernel operation performed at this zone's locations (e.g. "Load"/"Unload"/"Charge"), chosen
   *  per-zone at create/edit time from the location type's allowed operations. NULL falls back to
   *  the system-wide `loadOperation`/`unloadOperation` default for the zone's kind. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  operation!: string | null;

  /** Optional cap on concurrently-servicing vehicles for this zone. Stored as entered; not yet
   *  enforced anywhere in dispatch/assignment. */
  @Column({ name: 'max_vehicles', type: 'integer', nullable: true })
  maxVehicles!: number | null;

  /** Unique sequential ID used to name openTCS locations. NULL for PICKUP zones. */
  @Column({ name: 'kernel_id', type: 'integer', nullable: true, unique: true })
  kernelId!: number | null;

  /**
   * openTCS plant model name this zone was drawn on. NULL for zones created before map scoping.
   * Kept as metadata for kernel reconciliation (matching the live kernel's reported name); the
   * authoritative "which map record does this zone belong to" is `mapRecordId` below — a name
   * can be shared by more than one uploaded record, `mapRecordId` cannot.
   */
  @Column({
    name: 'plant_model_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  plantModelName!: string | null;

  /** The `map_records` row this zone belongs to. NULL for zones not yet resolved to one — see
   *  `resolveBackfillMatch`; a `NULL` here means "no map currently claims this zone's geometry",
   *  not "belongs to every map". */
  @Column({ name: 'map_record_id', type: 'uuid', nullable: true })
  mapRecordId!: string | null;

  @Column({
    type: 'enum',
    enum: ZoneStatus,
    enumName: 'zone_status_enum',
    default: ZoneStatus.ACTIVE,
  })
  status!: ZoneStatus;

  @OneToMany(() => ZoneMemberEntity, (m) => m.zone, {
    cascade: true,
    eager: true,
  })
  members!: ZoneMemberEntity[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
