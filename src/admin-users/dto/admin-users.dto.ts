import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

export class CreateAdminUserDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @Matches(/^[a-z0-9._]+$/, {
    message: 'Username chỉ gồm chữ thường, số, dấu chấm và gạch dưới.',
  })
  username!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  shift?: string;

  @IsString()
  @IsNotEmpty()
  role!: string;

  @IsOptional()
  @IsBoolean()
  sendInvite?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsBoolean()
  mustChangePassword?: boolean;
}

export class UpdateAdminUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  shift?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  role?: string;
}

export class SetRoleDto {
  @IsString()
  @IsNotEmpty()
  role!: string;
}

export class LockDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class ResetPasswordDto {
  @IsIn(['link', 'temp'])
  method!: 'link' | 'temp';

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}
