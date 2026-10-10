import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ApiTokenEntity } from '../users/entities/api-token.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from '../auth/auth.service';
import { PermissionsService } from '../auth/permissions.service';
import { isJwtShaped } from '../auth/token-extract.util';

export interface ApiTokenDto {
  id: string;
  jti: string | null;
  kind: 'generated' | 'pasted';
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function toDto(row: ApiTokenEntity): ApiTokenDto {
  return {
    id: row.id,
    jti: row.jti,
    kind: row.jti ? 'generated' : 'pasted',
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

@Injectable()
export class TokensService {
  constructor(
    @InjectRepository(ApiTokenEntity)
    private readonly apiTokens: Repository<ApiTokenEntity>,
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly permissions: PermissionsService,
  ) {}

  async list(userId: string): Promise<ApiTokenDto[]> {
    await this.users.findByIdOrFail(userId);
    const rows = await this.apiTokens.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return rows.map(toDto);
  }

  async issue(
    userId: string,
    label: string | undefined,
    actorId: string,
  ): Promise<{ token: string } & ApiTokenDto> {
    const user = await this.users.findByIdOrFail(userId);
    const jti = randomUUID();
    const token = this.auth.signPermanent(user, jti);
    const row = await this.apiTokens.save(
      this.apiTokens.create({
        userId,
        jti,
        label: label?.trim() || null,
        createdBy: actorId,
      }),
    );
    return { token, ...toDto(row) };
  }

  /** Adopt an opaque token issued elsewhere — never verified by signature, only by exact match. */
  async adopt(
    userId: string,
    rawToken: string,
    label: string | undefined,
    actorId: string,
  ): Promise<ApiTokenDto> {
    await this.users.findByIdOrFail(userId);
    const trimmed = rawToken.trim();
    if (isJwtShaped(trimmed)) {
      throw new BadRequestException(
        'Chuỗi dán vào có dạng JWT (3 đoạn cách nhau bởi dấu chấm) — hệ thống sẽ luôn thử xác minh nó như một JWT trước và thất bại vì không do hệ thống này ký. Dùng "Tự sinh" nếu cần JWT.',
      );
    }

    const hash = this.permissions.hashToken(trimmed);
    if (await this.permissions.isTokenHashTaken(hash)) {
      throw new ConflictException(
        'Token này đã được gán cho một tài khoản khác — mỗi token chỉ dùng được cho đúng một tài khoản.',
      );
    }

    const row = await this.apiTokens.save(
      this.apiTokens.create({
        userId,
        tokenHash: hash,
        label: label?.trim() || null,
        createdBy: actorId,
      }),
    );
    return toDto(row);
  }

  async revoke(id: string): Promise<ApiTokenDto> {
    const row = await this.apiTokens.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Không tìm thấy token.');
    if (!row.revokedAt) {
      row.revokedAt = new Date();
      await this.apiTokens.save(row);
    }
    return toDto(row);
  }
}
