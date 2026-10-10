import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { ZoneService } from './zone.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/jwt-payload';
import {
  AssignZoneMapDto,
  CreateZoneDto,
  ListZonesQueryDto,
  UpdateZoneDto,
} from './zone.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('zones')
export class ZoneController {
  constructor(private readonly zones: ZoneService) {}

  @Get()
  list(@Query() query: ListZonesQueryDto, @CurrentUser() user: AuthUser) {
    return this.zones.list({
      allMaps: query.allMaps ?? false,
      mapIds: user.mapIds,
    });
  }

  @Post()
  @RequirePermissions('area.create')
  create(@Body() dto: CreateZoneDto, @CurrentUser() user: AuthUser) {
    return this.zones.create(dto, user.mapIds);
  }

  @Patch(':id')
  @RequirePermissions('area.edit')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateZoneDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.zones.update(id, dto, user.mapIds);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('area.delete')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.zones.remove(id, user.mapIds);
  }

  @Post('sync')
  @RequirePermissions('area.sync_kernel')
  sync(@CurrentUser() user: AuthUser) {
    return this.zones.sync(user.mapIds);
  }

  @Post('assign-map')
  @HttpCode(200)
  @RequirePermissions('area.edit')
  assignMap(@Body() dto: AssignZoneMapDto, @CurrentUser() user: AuthUser) {
    return this.zones.assignToLoadedMap(dto.zoneIds, user.mapIds);
  }
}
