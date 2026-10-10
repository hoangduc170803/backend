import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * A catalogue row mirroring one entry of `permission.catalogue.ts`. Upserted on boot;
 * never edited by users. Used by the role editor to render the checkbox matrix with labels.
 */
@Entity('permissions')
export class PermissionEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  key!: string;

  @Column({ type: 'varchar', length: 32 })
  cluster!: string;

  @Column({ name: 'is_dangerous', default: false })
  isDangerous!: boolean;

  @Column({ type: 'int', default: 0 })
  sort!: number;

  /** Left-nav screen the key belongs to (`operating`, `map`, … or `system`). */
  @Column({ type: 'varchar', length: 32, default: 'system' })
  screen!: string;

  /** Section of that screen (`toolbar`, `map`, `drawer`, `dock`, `col.vehicles`, …). */
  @Column({
    name: 'group_key',
    type: 'varchar',
    length: 48,
    default: 'actions',
  })
  groupKey!: string;

  /** `screen` | `action` | `ui` | `column` | `api` — see `permission.catalogue.ts`. */
  @Column({ type: 'varchar', length: 16, default: 'action' })
  kind!: string;

  /** Key this one hangs under; effective only while every ancestor is granted. */
  @Column({ name: 'parent_key', type: 'varchar', length: 64, nullable: true })
  parentKey!: string | null;

  @Column({ name: 'label_vi', type: 'varchar', length: 160, nullable: true })
  labelVi!: string | null;

  @Column({ name: 'label_en', type: 'varchar', length: 160, nullable: true })
  labelEn!: string | null;

  @Column({ name: 'label_ja', type: 'varchar', length: 160, nullable: true })
  labelJa!: string | null;
}
