import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateRoleDto {
  @IsString()
  @Matches(/^[a-z0-9_-]+$/, {
    message: 'Mã vai trò chỉ gồm chữ thường, số, gạch dưới và gạch nối.',
  })
  @MinLength(2)
  @MaxLength(48)
  key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions!: string[];
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions?: string[];

  @ApiPropertyOptional({
    description:
      'Đánh dấu vai trò là admin: luôn giữ toàn bộ quyền trong catalogue, kể cả quyền thêm về sau. `false` bỏ đánh dấu (giữ nguyên các quyền đang có, ma trận sửa lại được). Không gửi kèm `permissions` khi bật.',
  })
  @IsOptional()
  @IsBoolean()
  fullAccess?: boolean;
}

export class SetRoleMapScopeDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  mapRecordIds!: string[];
}

export class IssueTokenDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class AdoptTokenDto {
  @IsString()
  @MinLength(16)
  @MaxLength(2048)
  token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}
