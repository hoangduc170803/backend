import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { RefreshTokenEntity } from '../users/entities/refresh-token.entity';
import { PasswordResetTokenEntity } from '../users/entities/password-reset-token.entity';
import { UserSessionEntity } from '../users/entities/user-session.entity';

const sha256 = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex');

@Injectable()
export class TokenService {
  private readonly refreshTtlMs: number;
  private readonly resetTtlMs: number;

  constructor(
    config: ConfigService,
    @InjectRepository(RefreshTokenEntity)
    private readonly refreshTokens: Repository<RefreshTokenEntity>,
    @InjectRepository(PasswordResetTokenEntity)
    private readonly resetTokens: Repository<PasswordResetTokenEntity>,
    @InjectRepository(UserSessionEntity)
    private readonly sessions: Repository<UserSessionEntity>,
  ) {
    this.refreshTtlMs = Number(config.get('REFRESH_TTL_DAYS', '7')) * 86400_000;
    this.resetTtlMs = Number(config.get('RESET_TTL_MINUTES', '30')) * 60_000;
  }

  // ── Refresh tokens ──────────────────────────────────────────────────────────
  async issueRefreshToken(
    userId: string,
    sessionId: string | null = null,
  ): Promise<string> {
    const raw = randomBytes(40).toString('hex');
    await this.refreshTokens.save(
      this.refreshTokens.create({
        userId,
        sessionId,
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + this.refreshTtlMs),
      }),
    );
    return raw;
  }

  /**
   * Validate + rotate atomically: the conditional UPDATE only flips a row that is still
   * `is_revoked = false`, so two concurrent callers racing the same raw token can never both
   * succeed — the loser gets 0 affected rows instead of silently reusing an already-rotated
   * token. Returns null if the token is unknown, already used, or expired.
   */
  async rotateRefreshToken(raw: string): Promise<{
    userId: string;
    token: string;
    sessionId: string | null;
  } | null> {
    const result = await this.refreshTokens
      .createQueryBuilder()
      .update(RefreshTokenEntity)
      .set({ isRevoked: true })
      .where('token_hash = :hash', { hash: sha256(raw) })
      .andWhere('is_revoked = false')
      .andWhere('expires_at > now()')
      // Array entries are entity property paths; raw results use database names.
      .returning(['id', 'userId', 'sessionId'])
      .execute();
    const [row] = result.raw as {
      id: string;
      user_id: string;
      session_id: string | null;
    }[];
    if (!row) return null;
    const token = await this.issueRefreshToken(row.user_id, row.session_id);
    return { userId: row.user_id, token, sessionId: row.session_id };
  }

  async revokeRefreshToken(raw: string): Promise<void> {
    if (!raw) return;
    await this.refreshTokens.update(
      { tokenHash: sha256(raw) },
      { isRevoked: true },
    );
  }

  async revokeAllRefreshTokens(userId: string): Promise<void> {
    await this.refreshTokens.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );
  }

  // ── Password reset tokens ─────────────────────────────────────────────────────
  async createResetToken(userId: string): Promise<string> {
    const raw = randomBytes(32).toString('hex');
    await this.resetTokens.save(
      this.resetTokens.create({
        userId,
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + this.resetTtlMs),
      }),
    );
    return raw;
  }

  /**
   * Returns userId if the reset token is valid + unused, marking it used — atomically, so two
   * concurrent requests with the same raw token can't both read it as unused before either
   * writes (see `rotateRefreshToken` for the same pattern).
   */
  async consumeResetToken(raw: string): Promise<string | null> {
    const result = await this.resetTokens
      .createQueryBuilder()
      .update(PasswordResetTokenEntity)
      .set({ usedAt: () => 'now()' })
      .where('token_hash = :hash', { hash: sha256(raw) })
      .andWhere('used_at IS NULL')
      .andWhere('expires_at > now()')
      .returning(['userId'])
      .execute();
    const [row] = result.raw as { user_id: string }[];
    return row?.user_id ?? null;
  }

  // ── Sessions ────────────────────────────────────────────────────────────────
  /** Returns the new session's id — embedded in the access/refresh token pair so logout and
   *  revoke-this-session act on the exact device that asked, not on every device at once. */
  async startSession(
    userId: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<string> {
    const session = await this.sessions.save(
      this.sessions.create({
        userId,
        ipAddress: ip,
        userAgent,
        loginAt: new Date(),
      }),
    );
    return session.id;
  }

  /** True if the session exists and hasn't been logged out/revoked. */
  async sessionActive(sessionId: string): Promise<boolean> {
    const session = await this.sessions.findOne({
      where: { id: sessionId, logoutAt: IsNull() },
    });
    return !!session;
  }

  /** End exactly one session — used by a normal logout, which must never end other devices. */
  async endSession(sessionId: string): Promise<void> {
    await this.sessions.update(
      { id: sessionId, logoutAt: IsNull() },
      { logoutAt: new Date() },
    );
  }

  /** Admin-forced: end every session for the user (lock/remove/force-reset). */
  async endAllSessions(userId: string): Promise<void> {
    await this.sessions.update(
      { userId, logoutAt: IsNull() },
      { logoutAt: new Date() },
    );
  }

  /** End every other active session, excluding the caller's own (by id, not "most recent"). */
  async endOtherSessions(
    userId: string,
    currentSessionId: string | null,
  ): Promise<void> {
    await this.sessions.update(
      {
        userId,
        logoutAt: IsNull(),
        ...(currentSessionId ? { id: Not(currentSessionId) } : {}),
      },
      { logoutAt: new Date() },
    );
  }

  /** Drops expired refresh tokens — otherwise the table only ever grows. */
  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpired(): Promise<void> {
    await this.refreshTokens.delete({ expiresAt: LessThan(new Date()) });
  }
}
