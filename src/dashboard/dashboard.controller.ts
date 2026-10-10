import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/jwt-payload';
import { DashboardService } from './dashboard.service';
import { KpiQueryDto } from './dashboard.dto';

@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  /** KPIs of the loaded map by default; `scope=all` / `mapRecordId` widen or pick another map. */
  @Get('kpis')
  kpis(@Query() query: KpiQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.kpis(query.window, query, user.mapIds);
  }
}
