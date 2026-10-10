import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A permanent (no-`exp`) access credential for a user account — for customer / kiosk clients.
 * Exactly one of `jti` / `tokenHash` is set:
 *  - `jti`: a system-generated JWT; the JWT itself is self-verifying, this row only gates
 *    revocation.
 *  - `tokenHash`: an opaque string pasted in from another system — the raw value is never
 *    stored, only its SHA-256 hash (same convention as refresh/reset tokens); requests
 *    presenting the exact matching string authenticate as `userId`.
 */
@Entity('api_tokens')
export class ApiTokenEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'uuid', nullable: true })
  jti!: string | null;

  @Column({ name: 'token_hash', type: 'varchar', length: 64, nullable: true })
  tokenHash!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  label!: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
