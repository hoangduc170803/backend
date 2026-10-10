import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { RoleEntity } from './role.entity';

/** One map record a role is restricted to. A role with no rows here is unrestricted. */
@Entity('role_map_scopes')
export class RoleMapScopeEntity {
  @PrimaryColumn({ name: 'role_id', type: 'smallint' })
  roleId!: number;

  @PrimaryColumn({ name: 'map_record_id', type: 'uuid' })
  mapRecordId!: string;

  @ManyToOne(() => RoleEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'role_id' })
  role!: RoleEntity;
}
