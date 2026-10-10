import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserRoleEntity } from './user-role.entity';

@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  username!: string;

  @Column()
  email!: string;

  @Column({ name: 'password_hash' })
  passwordHash!: string;

  @Column({ name: 'full_name' })
  fullName!: string;

  @Column({ type: 'varchar', nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', nullable: true })
  shift!: string | null;

  @Column({ name: 'avatar_url', type: 'text', nullable: true })
  avatarUrl!: string | null;

  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  @Column({ name: 'is_locked', default: false })
  isLocked!: boolean;

  @Column({ name: 'is_invited', default: false })
  isInvited!: boolean;

  @Column({ name: 'must_change_password', default: false })
  mustChangePassword!: boolean;

  @Column({
    name: 'password_changed_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  passwordChangedAt!: Date;

  @Column({ name: 'lock_reason', type: 'text', nullable: true })
  lockReason!: string | null;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @OneToMany(() => UserRoleEntity, (ur) => ur.user)
  userRoles!: UserRoleEntity[];
}
