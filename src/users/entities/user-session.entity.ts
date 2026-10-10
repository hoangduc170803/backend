import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('user_sessions')
export class UserSessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'ip_address', type: 'inet', nullable: true })
  ipAddress!: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({ name: 'login_at', type: 'timestamptz', default: () => 'NOW()' })
  loginAt!: Date;

  @Column({ name: 'logout_at', type: 'timestamptz', nullable: true })
  logoutAt!: Date | null;
}
