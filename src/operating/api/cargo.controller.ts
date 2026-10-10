import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthUser } from '../../auth/jwt-payload';
import { OperatingCargoService } from '../application/operating-cargo.service';
import { MapScopeQueryDto } from '../../maps/domain/map-scope';
import type {
  CargoDeleteResponse,
  CargoDto,
  CargoListDto,
} from '../dto/operating.dto';
import { CreateCargoBody, DeleteCargosBody } from '../dto/operating.dto';

@ApiTags('operating')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('operating/cargo')
export class OperatingCargoController {
  constructor(private readonly cargo: OperatingCargoService) {}

  @Get()
  list(
    @Query() query: MapScopeQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CargoListDto> {
    return this.cargo.list(query, user.mapIds);
  }

  @Post()
  @RequirePermissions('cargo.create')
  create(
    @Body() body: CreateCargoBody,
    @CurrentUser() user: AuthUser,
  ): Promise<CargoDto> {
    return this.cargo.create(body, user.sub, user.mapIds);
  }

  @Post('delete')
  @RequirePermissions('cargo.cancel')
  cancelMany(
    @Body() body: DeleteCargosBody,
    @CurrentUser() user: AuthUser,
  ): Promise<CargoDeleteResponse> {
    return this.cargo.cancelMany(body.ids, user.mapIds);
  }

  @Delete(':id')
  @RequirePermissions('cargo.cancel')
  cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<CargoDto> {
    return this.cargo.cancel(id, user.mapIds);
  }
}
