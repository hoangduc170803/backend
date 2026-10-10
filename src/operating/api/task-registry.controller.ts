import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthUser } from '../../auth/jwt-payload';
import { TaskCancellationService } from '../../cargo/task-cancellation.service';
import { cancelPermissionsOf } from '../../auth/cancel-permissions';
import { CancelTasksDto, type TaskCancelResponse } from '../../cargo/cargo.dto';
import { TaskRegistryService } from '../application/task-registry.service';
import {
  ListTasksQueryDto,
  type TaskRegistryDetailDto,
  type TaskRegistryListDto,
} from '../dto/operating.dto';

@ApiTags('tasks')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('tasks')
export class TaskRegistryController {
  constructor(
    private readonly registry: TaskRegistryService,
    private readonly cancellation: TaskCancellationService,
  ) {}

  @Get()
  @ApiQuery({
    name: 'mapRecordIds',
    required: false,
    type: String,
    description: 'Comma-separated map UUIDs to include.',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: [
      'code',
      'kind',
      'cargo',
      'map',
      'status',
      'vehicle',
      'pickup',
      'destination',
      'leg',
      'created',
      'finished',
    ],
  })
  @ApiQuery({ name: 'sortDir', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({
    name: 'columnFilters',
    required: false,
    type: String,
    description:
      'JSON object mapping column keys to search terms; created and finished accept ISO datetimes.',
  })
  list(
    @Query() query: ListTasksQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TaskRegistryListDto> {
    return this.registry.list(query, user.mapIds);
  }

  @Get(':id')
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<TaskRegistryDetailDto> {
    return this.registry.detail(id, user.mapIds);
  }

  @Post('cancel')
  @HttpCode(200)
  cancel(
    @Body() body: CancelTasksDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TaskCancelResponse> {
    return this.cancellation.cancelTasks(body.ids, {
      permissions: cancelPermissionsOf(user),
      mapIds: user.mapIds,
    });
  }
}
