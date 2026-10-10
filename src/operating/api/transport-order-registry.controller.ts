import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthUser } from '../../auth/jwt-payload';
import { TransportOrderRegistryService } from '../application/transport-order-registry.service';
import {
  ListTransportOrdersQueryDto,
  type TransportOrderRegistryListDto,
} from '../dto/operating.dto';

/** Full-database transport-order history (the "Lệnh vận chuyển" screen), every map. */
@ApiTags('tasks')
@UseGuards(JwtAuthGuard)
@Controller('transport-orders')
export class TransportOrderRegistryController {
  constructor(private readonly registry: TransportOrderRegistryService) {}

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
      'order',
      'leg',
      'state',
      'vehicle',
      'destinations',
      'task',
      'cargo',
      'map',
      'created',
      'ended',
    ],
  })
  @ApiQuery({ name: 'sortDir', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({
    name: 'columnFilters',
    required: false,
    type: String,
    description:
      'JSON object mapping column keys to search terms; created and ended accept ISO datetimes.',
  })
  list(
    @Query() query: ListTransportOrdersQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TransportOrderRegistryListDto> {
    return this.registry.list(query, user.mapIds);
  }
}
