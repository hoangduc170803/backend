import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminUsersService } from './admin-users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/jwt-payload';
import {
  CreateAdminUserDto,
  LockDto,
  ResetPasswordDto,
  SetRoleDto,
  UpdateAdminUserDto,
} from './dto/admin-users.dto';
import type { UserStatus } from '../users/user.mapper';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly admin: AdminUsersService) {}

  @Get()
  @RequirePermissions('users.view')
  list(
    @Query('search') search?: string,
    @Query('role') role?: string,
    @Query('status') status?: UserStatus | 'all',
  ) {
    return this.admin.list({ search, role, status });
  }

  @Post()
  @RequirePermissions('users.manage')
  create(@Body() dto: CreateAdminUserDto, @CurrentUser() actor: AuthUser) {
    return this.admin.create(dto, actor.sub);
  }

  @Patch(':id')
  @RequirePermissions('users.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAdminUserDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.admin.update(id, dto, actor.sub);
  }

  @Delete(':id')
  @RequirePermissions('users.manage')
  @HttpCode(200)
  remove(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.admin.remove(id, actor.sub);
  }

  @Put(':id/role')
  @RequirePermissions('users.manage')
  setRole(
    @Param('id') id: string,
    @Body() dto: SetRoleDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.admin.setRole(id, dto.role, actor.sub);
  }

  @Post(':id/lock')
  @RequirePermissions('users.manage')
  lock(
    @Param('id') id: string,
    @Body() dto: LockDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.admin.lock(id, dto.reason, actor.sub);
  }

  @Post(':id/unlock')
  @RequirePermissions('users.manage')
  unlock(@Param('id') id: string) {
    return this.admin.unlock(id);
  }

  @Post(':id/activate')
  @RequirePermissions('users.manage')
  activate(@Param('id') id: string) {
    return this.admin.activate(id);
  }

  @Post(':id/reset-password')
  @RequirePermissions('users.manage')
  @HttpCode(200)
  async resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto) {
    const result = await this.admin.resetPassword(id, dto);
    return { ok: true, ...result };
  }
}
