import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export interface StoredMapPreview {
  /** Bumped whenever the parser/renderer that derives this shape from XML changes; a stored
   *  value below `CURRENT_PREVIEW_VERSION` (or a legacy row with none at all) is regenerated
   *  from the original XML on next read instead of served stale. */
  previewVersion: number;
  points: Array<{
    name: string;
    x: number;
    y: number;
    type: string;
  }>;
  paths: Array<{
    name: string;
    source: string;
    target: string;
    locked: boolean;
  }>;
}

@Entity('map_records')
export class MapRecordEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column({ name: 'original_filename' })
  originalFilename!: string;

  @Column({ name: 'point_count', type: 'int', default: 0 })
  pointCount!: number;

  @Column({ name: 'path_count', type: 'int', default: 0 })
  pathCount!: number;

  @Column({ name: 'vehicle_count', type: 'int', default: 0 })
  vehicleCount!: number;

  @Column({ name: 'location_count', type: 'int', default: 0 })
  locationCount!: number;

  @Column({ name: 'block_count', type: 'int', default: 0 })
  blockCount!: number;

  /** The original upload is the source used for downloads and later kernel loads. */
  @Column({ name: 'xml_content', type: 'text', nullable: true, select: false })
  xmlContent!: string | null;

  /** Small, render-ready geometry so listing cards never has to parse every XML document. */
  @Column({ name: 'preview', type: 'jsonb', nullable: true })
  preview!: StoredMapPreview | null;

  @CreateDateColumn({ name: 'uploaded_at', type: 'timestamptz' })
  uploadedAt!: Date;

  @Column({ name: 'uploaded_by_id', type: 'uuid', nullable: true })
  uploadedById!: string | null;

  @Column({ name: 'last_loaded_at', type: 'timestamptz', nullable: true })
  lastLoadedAt!: Date | null;

  /** Removed from the library. The row stays so history lists can still name the map. */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz' })
  deletedAt!: Date | null;
}
