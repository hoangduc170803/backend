import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthUser } from '../../auth/jwt-payload';
import { OperatingTasksService } from '../application/operating-tasks.service';
import type { TaskListDto } from '../dto/operating.dto';
import { MapScopeQueryDto } from '../../maps/domain/map-scope';

@ApiTags('operating')
@UseGuards(JwtAuthGuard)
@Controller('operating/tasks')
export class OperatingTasksController {
  constructor(private readonly tasks: OperatingTasksService) {}

  @Get()
  list(
    @Query() query: MapScopeQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TaskListDto> {
    return this.tasks.list(query, user.mapIds);
  }
}
