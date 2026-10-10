import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('user_preferences')
export class UserPreferenceEntity {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', default: 'vi' })
  language!: string;

  @Column({ name: 'notifications_enabled', default: true })
  notificationsEnabled!: boolean;

  @Column({ name: 'sound_enabled', default: false })
  soundEnabled!: boolean;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'NOW()' })
  updatedAt!: Date;
}
