import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CargoService } from './cargo.service';
import { CargoStatus } from './entities/cargo.entity';
import { DispatchSchedulerService } from './dispatch-scheduler.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/jwt-payload';
import { CreateCargoDto, ListCargosQueryDto } from './cargo.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Cargo')
@ApiBearerAuth()
@Controller('cargo')
export class CargoController {
  constructor(
    private readonly service: CargoService,
    private readonly dispatcher: DispatchSchedulerService,
  ) {}

  @Get()
  list(@Query() query: ListCargosQueryDto) {
    return this.service.list(query);
  }

  @Get('registry')
  @RequirePermissions('screen.cargo')
  @ApiOperation({
    summary: 'List cargo across all maps with full-result counts',
    description:
      'Requires screen.cargo. Includes soft-deleted and mapless legacy cargo. The from/to timestamps filter createdAt inclusively; the response is paginated while summaries cover every matching row.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: '1 to 200; defaults to 20.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Matches item code, source point, or destination location.',
  })
  @ApiQuery({ name: 'status', required: false, enum: CargoStatus })
  @ApiQuery({
    name: 'statuses',
    required: false,
    type: String,
    description: 'Comma-separated cargo statuses.',
  })
  @ApiQuery({
    name: 'mapRecordIds',
    required: false,
    type: String,
    description: 'Comma-separated map UUIDs.',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: [
      'code',
      'map',
      'status',
      'task',
      'source',
      'destination',
      'vehicle',
      'created',
      'updated',
    ],
  })
  @ApiQuery({ name: 'sortDir', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({
    name: 'columnFilters',
    required: false,
    type: String,
    description:
      'JSON object mapping column keys to search terms; date columns accept ISO timestamps at minute precision.',
  })
  @ApiQuery({
    name: 'mapRecordId',
    required: false,
    type: String,
    format: 'uuid',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    format: 'date-time',
  })
  @ApiQuery({ name: 'to', required: false, type: String, format: 'date-time' })
  @ApiBadRequestResponse({
    description: 'Invalid filter, timestamp, or reversed time range.',
  })
  @ApiForbiddenResponse({ description: 'The user lacks screen.cargo.' })
  @ApiOkResponse({
    description:
      'Paginated cargos, total count, and full-result outcome counts. `delivered` counts every cargo that reached its destination, including ones removed afterwards; `failed` counts cargo that ended (failed or removed) without being delivered; `active` counts cargo still in the system, of which `running` are being carried out by a vehicle right now.',
    schema: {
      type: 'object',
      properties: {
        cargos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              itemCode: { type: 'string' },
              status: { type: 'string', enum: Object.values(CargoStatus) },
              taskStatus: { type: 'string', nullable: true },
              mapRecordId: { type: 'string', nullable: true },
              sourcePointName: { type: 'string', nullable: true },
              destinationLocationName: { type: 'string', nullable: true },
              assignedVehicleName: { type: 'string', nullable: true },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
              deliveredAt: {
                type: 'string',
                format: 'date-time',
                nullable: true,
              },
              deletedAt: {
                type: 'string',
                format: 'date-time',
                nullable: true,
              },
            },
          },
        },
        total: { type: 'number' },
        page: { type: 'number' },
        limit: { type: 'number' },
        truncated: { type: 'boolean' },
        summary: {
          type: 'object',
          properties: {
            delivered: { type: 'number' },
            failed: { type: 'number' },
            active: { type: 'number' },
            running: { type: 'number' },
          },
        },
      },
    },
  })
  registry(@Query() query: ListCargosQueryDto) {
    return this.service.registry(query);
  }

  @Get(':id/decision')
  assignmentDecision(@Param('id') id: string) {
    return this.service.getAssignmentDecision(id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @RequirePermissions('cargo.create')
  create(@Body() dto: CreateCargoDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user.sub);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('cargo.cancel')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post('dispatch/trigger')
  @HttpCode(204)
  @RequirePermissions('cargo.create')
  triggerDispatch() {
    this.dispatcher.schedule();
  }
}
