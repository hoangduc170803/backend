import { ConfigService } from '@nestjs/config';
import { DataSource, UpdateQueryBuilder } from 'typeorm';
import { RefreshTokenEntity } from '../users/entities/refresh-token.entity';
import { PasswordResetTokenEntity } from '../users/entities/password-reset-token.entity';
import { UserSessionEntity } from '../users/entities/user-session.entity';
import { TokenService } from './token.service';

class MetadataDataSource extends DataSource {
  async prepare() {
    await this.buildMetadatas();
  }
}

describe('TokenService PostgreSQL returning columns', () => {
  let service: TokenService;

  beforeAll(async () => {
    const source = new MetadataDataSource({
      type: 'postgres',
      entities: [
        RefreshTokenEntity,
        PasswordResetTokenEntity,
        UserSessionEntity,
      ],
    });
    await source.prepare();
    service = new TokenService(
      new ConfigService(),
      source.getRepository(RefreshTokenEntity),
      source.getRepository(PasswordResetTokenEntity),
      source.getRepository(UserSessionEntity),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns the user and session when rotating a refresh token', async () => {
    jest
      .spyOn(UpdateQueryBuilder.prototype, 'execute')
      .mockImplementation(function (
        this: UpdateQueryBuilder<RefreshTokenEntity>,
      ) {
        expect(this.getQuery()).toContain(
          'RETURNING "id", "user_id", "session_id"',
        );
        return Promise.resolve({
          raw: [
            { id: 'token-id', user_id: 'user-id', session_id: 'session-id' },
          ],
          affected: 1,
          generatedMaps: [],
        });
      });
    const issue = jest
      .spyOn(service, 'issueRefreshToken')
      .mockResolvedValue('rotated');
    await expect(service.rotateRefreshToken('original')).resolves.toEqual({
      userId: 'user-id',
      sessionId: 'session-id',
      token: 'rotated',
    });
    expect(issue).toHaveBeenCalledWith('user-id', 'session-id');
  });

  it('returns the user when consuming a password reset token', async () => {
    jest
      .spyOn(UpdateQueryBuilder.prototype, 'execute')
      .mockImplementation(function (
        this: UpdateQueryBuilder<PasswordResetTokenEntity>,
      ) {
        expect(this.getQuery()).toContain('RETURNING "user_id"');
        return Promise.resolve({
          raw: [{ user_id: 'user-id' }],
          affected: 1,
          generatedMaps: [],
        });
      });
    await expect(service.consumeResetToken('reset-token')).resolves.toBe(
      'user-id',
    );
  });

  it('rejects consumed or expired tokens without issuing a replacement', async () => {
    jest.spyOn(UpdateQueryBuilder.prototype, 'execute').mockResolvedValue({
      raw: [],
      affected: 0,
      generatedMaps: [],
    });
    const issue = jest.spyOn(service, 'issueRefreshToken');
    await expect(service.rotateRefreshToken('used-token')).resolves.toBeNull();
    await expect(service.consumeResetToken('used-token')).resolves.toBeNull();
    expect(issue).not.toHaveBeenCalled();
  });

  it('ends every other open session of the user in one statement', async () => {
    const queries: string[] = [];
    jest
      .spyOn(UpdateQueryBuilder.prototype, 'execute')
      .mockImplementation(function (
        this: UpdateQueryBuilder<UserSessionEntity>,
      ) {
        queries.push(this.getQuery());
        return Promise.resolve({ raw: [], affected: 3, generatedMaps: [] });
      });

    await service.endOtherSessions('user-1', 'session-keep');

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('"logout_at" IS NULL');
    expect(queries[0]).toContain('"id" != ');
  });
});
