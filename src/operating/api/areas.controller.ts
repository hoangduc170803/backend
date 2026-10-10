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
import {
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthUser } from '../../auth/jwt-payload';
import { OperatingAreasService } from '../application/operating-areas.service';
import { MapScopeQueryDto } from '../../maps/domain/map-scope';
import type { AreaDto, CopyAreasFromMapResult } from '../dto/operating.dto';
import {
  AreaCargoPurgeResult,
  CopyAreasFromMapBody,
  CreateAreaBody,
  ReplaceAreaMembersBody,
  UpdateAreaBody,
} from '../dto/operating.dto';

@ApiTags('operating')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('operating/areas')
export class OperatingAreasController {
  constructor(private readonly areas: OperatingAreasService) {}

  @Get()
  list(
    @Query() query: MapScopeQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AreaDto[]> {
    return this.areas.list(user.mapIds, query);
  }

  @Post('sync')
  @RequirePermissions('area.sync_kernel')
  sync(@CurrentUser() user: AuthUser) {
    return this.areas.sync(user.mapIds);
  }

  @Post('copy-from-map')
  @RequirePermissions('area.create')
  copyFromMap(
    @Body() body: CopyAreasFromMapBody,
    @CurrentUser() user: AuthUser,
  ): Promise<CopyAreasFromMapResult> {
    return this.areas.copyFromMap(body, user.mapIds);
  }

  @Post()
  @RequirePermissions('area.create')
  create(
    @Body() body: CreateAreaBody,
    @CurrentUser() user: AuthUser,
  ): Promise<AreaDto> {
    return this.areas.create(body, user.mapIds);
  }

  @Patch(':wesId')
  @RequirePermissions('area.edit')
  update(
    @Param('wesId') wesId: string,
    @Body() body: UpdateAreaBody,
    @CurrentUser() user: AuthUser,
  ): Promise<AreaDto> {
    return this.areas.update(wesId, body, user.mapIds);
  }

  @Put(':wesId/members')
  @RequirePermissions('area.edit')
  replaceMembers(
    @Param('wesId') wesId: string,
    @Body() body: ReplaceAreaMembersBody,
    @CurrentUser() user: AuthUser,
  ): Promise<AreaDto> {
    return this.areas.replaceMembers(wesId, body, user.mapIds);
  }

  @Post(':wesId/cargo/purge-finished')
  @ApiOperation({
    summary: 'Xoá toàn bộ hàng đã hoàn thành của một khu vực',
    description:
      'Quyền `area.purge_cargo`. Xoá mọi hàng có điểm lấy hoặc kho đích thuộc khu vực, chỉ khi không còn hàng nào đang xử lý (chờ, đang lấy, đang giao). 403 nếu bản đồ đang nạp nằm ngoài phạm vi của vai trò; 404 nếu khu vực không thuộc bản đồ đang nạp.',
  })
  @ApiOkResponse({ type: AreaCargoPurgeResult })
  @ApiConflictResponse({
    description: 'Còn hàng chưa hoàn thành trong khu vực — không xoá gì cả.',
  })
  @RequirePermissions('area.purge_cargo')
  @HttpCode(200)
  purgeFinishedCargo(
    @Param('wesId') wesId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<AreaCargoPurgeResult> {
    return this.areas.purgeFinishedCargo(wesId, user.mapIds);
  }

  @Delete(':wesId')
  @RequirePermissions('area.delete')
  @HttpCode(200)
  remove(
    @Param('wesId') wesId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.areas.remove(wesId, user.mapIds);
  }
}
