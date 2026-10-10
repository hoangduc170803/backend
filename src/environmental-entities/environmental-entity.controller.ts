import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/jwt-payload';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import {
  EnvironmentalEntitySyncService,
  toSyncView,
} from './environmental-entity-sync.service';
import { EnvironmentalEntityAdminService } from './environmental-entity-admin.service';
import { EntitySyncStore } from './entity-sync.store';
import { ObstacleAdminQueryDto } from './environmental-entity.dto';
import type {
  EntitySyncView,
  EnvironmentalEntityAdminListDto,
  EnvironmentalEntityLogDto,
  EnvironmentalEntityOverlayListDto,
} from './environmental-entity.dto';

const OUT_OF_SCOPE =
  'Vai trò của bạn không được gán quyền thao tác trên bản đồ này.';

@ApiTags('operating')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('operating')
export class EnvironmentalEntityController {
  constructor(
    private readonly sync: EnvironmentalEntitySyncService,
    private readonly admin: EnvironmentalEntityAdminService,
    private readonly store: EntitySyncStore,
    private readonly activeMap: ActiveMapContext,
  ) {}

  /** Map overlay: obstacles of the loaded map only. */
  @Get('environmental-entities')
  async list(
    @CurrentUser() user: AuthUser,
  ): Promise<EnvironmentalEntityOverlayListDto> {
    const activeMapId = await this.activeMap.id();
    const footprint = this.sync.cargoFootprint;
    if (
      user.mapIds !== undefined &&
      (!activeMapId || !user.mapIds.includes(activeMapId))
    ) {
      return { footprint, entities: [] };
    }
    return { footprint, entities: await this.sync.overlayFor(activeMapId) };
  }

  @Get('environmental-entities/admin')
  @ApiOperation({
    summary: 'Bảng vật cản (phân trang)',
    description:
      'Một trang của bảng vật cản, mới nhất trước; mặc định 20 dòng. Mặc định là bản đồ đang nạp; ' +
      '`scope=all` hoặc `mapRecordId` mở rộng ra toàn bộ cơ sở dữ liệu trong phạm vi bản đồ của vai trò. ' +
      'Lọc (`filters`), tìm (`search`) và thu hẹp theo bản đồ (`mapRecordIds`) chạy ở máy chủ. ' +
      '`kernelOnly` chỉ có ở trang 1. Chỉ cần đăng nhập.',
  })
  @ApiOkResponse({
    description:
      '`rows` của trang, `total` là tổng số dòng khớp bộ lọc, kèm `page` và `limit`.',
  })
  adminList(
    @Query() query: ObstacleAdminQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<EnvironmentalEntityAdminListDto> {
    return this.admin.list(query, user.mapIds);
  }

  @Get('environmental-entities/:cargoId/logs')
  async logs(
    @Param('cargoId', ParseUUIDPipe) cargoId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<EnvironmentalEntityLogDto[]> {
    await this.assertRowInScope(cargoId, user);
    return this.admin.logs(cargoId);
  }

  @Post('environmental-entities/:cargoId/retire')
  @HttpCode(200)
  @RequirePermissions('obstacles.manage')
  async retire(
    @Param('cargoId', ParseUUIDPipe) cargoId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<EntitySyncView> {
    await this.assertRowInScope(cargoId, user);
    return toSyncView(await this.sync.retireManually(cargoId, user.username));
  }

  @Post('environmental-entities/:cargoId/reactivate')
  @HttpCode(200)
  @RequirePermissions('obstacles.manage')
  async reactivate(
    @Param('cargoId', ParseUUIDPipe) cargoId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<EntitySyncView> {
    await this.assertRowInScope(cargoId, user);
    return toSyncView(
      await this.sync.reactivateManually(cargoId, user.username),
    );
  }

  /** Retire an entity WES has no row for, straight on the kernel (loaded map only). */
  @Post('environmental-entities/kernel/:name/retire')
  @HttpCode(200)
  @RequirePermissions('obstacles.manage')
  async retireKernelEntity(
    @Param('name') name: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ name: string }> {
    await this.assertLoadedMapInScope(user);
    await this.sync.retireKernelEntity(name, user.username);
    return { name };
  }

  @Post('cargo/:id/entity-sync/retry')
  @HttpCode(200)
  @RequirePermissions('cargo.cancel')
  async retry(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<EntitySyncView> {
    await this.assertLoadedMapInScope(user);
    return this.sync.retryNow(id);
  }

  private async assertRowInScope(
    cargoId: string,
    user: AuthUser,
  ): Promise<void> {
    if (user.mapIds === undefined) return;
    const row = await this.store.findByCargoId(cargoId);
    if (row && (!row.mapRecordId || !user.mapIds.includes(row.mapRecordId))) {
      throw new ForbiddenException(OUT_OF_SCOPE);
    }
  }

  private async assertLoadedMapInScope(user: AuthUser): Promise<void> {
    if (user.mapIds === undefined) return;
    const activeMapId = await this.activeMap.id();
    if (!activeMapId || !user.mapIds.includes(activeMapId)) {
      throw new ForbiddenException(OUT_OF_SCOPE);
    }
  }
}
