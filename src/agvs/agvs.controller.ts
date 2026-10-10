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
import { AgvsService } from './agvs.service';
import { AgvHistoryService } from './agv-history.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/jwt-payload';
import {
  AgvErrorFrequencyQueryDto,
  AgvHistoryQueryDto,
  AgvTaskHistoryQueryDto,
  CreateAgvDto,
  AgvIdsDto,
  ListAgvsQueryDto,
  SetAgvAcceptanceDto,
  SetAgvConnectionDto,
  UpdateAgvBatteryThresholdsDto,
  UpdateAgvDto,
} from './dto/agvs.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('agvs.manage')
@Controller('agvs')
export class AgvsController {
  constructor(
    private readonly service: AgvsService,
    private readonly history: AgvHistoryService,
  ) {}

  @Get()
  list(@Query() query: ListAgvsQueryDto) {
    return this.service.list(query);
  }

  @Get('error-frequency')
  errorFrequency(@Query() query: AgvErrorFrequencyQueryDto) {
    return this.history.errorFrequency(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Get(':id/history')
  taskHistory(@Param('id') id: string, @Query() query: AgvTaskHistoryQueryDto) {
    return this.history.taskHistory(id, query);
  }

  @Get(':id/state-log')
  stateLog(@Param('id') id: string, @Query() query: AgvHistoryQueryDto) {
    return this.history.stateLog(id, query);
  }

  @Get(':id/errors')
  errorHistory(@Param('id') id: string, @Query() query: AgvHistoryQueryDto) {
    return this.history.errorHistory(id, query);
  }

  @Post()
  create(@Body() dto: CreateAgvDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user.sub);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAgvDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/battery-thresholds')
  @RequirePermissions('agvs.battery_thresholds')
  updateBatteryThresholds(
    @Param('id') id: string,
    @Body() dto: UpdateAgvBatteryThresholdsDto,
  ) {
    return this.service.updateBatteryThresholds(id, dto);
  }

  @Post(':id/connect')
  @HttpCode(204)
  connect(@Param('id') id: string) {
    return this.service.connect(id);
  }

  @Post(':id/disconnect')
  @HttpCode(204)
  disconnect(@Param('id') id: string) {
    return this.service.disconnect(id);
  }

  @Post('acceptance')
  @HttpCode(200)
  setAcceptance(@Body() dto: SetAgvAcceptanceDto) {
    return this.service.setAcceptance(dto);
  }

  @Post('delete')
  @HttpCode(200)
  removeMany(@Body() dto: AgvIdsDto) {
    return this.service.removeMany(dto.ids);
  }

  @Post('connection')
  @HttpCode(200)
  setConnection(@Body() dto: SetAgvConnectionDto) {
    return this.service.setConnectionMany(dto.ids, dto.connected);
  }

  @Post(':id/enable')
  @HttpCode(200)
  enable(@Param('id') id: string) {
    return this.service.enable(id);
  }

  @Post(':id/disable')
  @HttpCode(200)
  disable(@Param('id') id: string) {
    return this.service.disable(id);
  }

  @Post(':id/ignore')
  @HttpCode(200)
  ignore(@Param('id') id: string) {
    return this.service.ignore(id);
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(@Param('id') id: string) {
    return this.service.restore(id);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
