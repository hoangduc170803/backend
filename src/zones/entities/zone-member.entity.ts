import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ZoneEntity } from './zone.entity';

@Entity('zone_members')
export class ZoneMemberEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'zone_id', type: 'uuid' })
  zoneId!: string;

  @ManyToOne(() => ZoneEntity, (z) => z.members, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'zone_id' })
  zone!: ZoneEntity;

  @Column({ name: 'location_name', type: 'varchar', length: 255 })
  locationName!: string;

  @Column({ name: 'position_index', type: 'int' })
  positionIndex!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
