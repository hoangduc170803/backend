import { Controller, MessageEvent, Sse, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { EMPTY, Observable, catchError, map, merge } from 'rxjs';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { sseHeartbeat$ } from '../../auth/sse-heartbeat';
import { TokenService } from '../../auth/token.service';
import { PermissionsService } from '../../auth/permissions.service';
import { UsersService } from '../../users/users.service';
import type { AuthUser } from '../../auth/jwt-payload';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { OperatingVehiclesService } from '../application/operating-vehicles.service';
import { OperatingCargoService } from '../application/operating-cargo.service';
import { OperatingAreasService } from '../application/operating-areas.service';
import { OperatingOrdersService } from '../application/operating-orders.service';
import { OperatingMapSyncService } from '../application/operating-map-sync.service';
import { OperatingTasksService } from '../application/operating-tasks.service';

const SSE_HEARTBEAT_MS = 15_000;

@ApiTags('operating')
@UseGuards(JwtAuthGuard)
@Controller('operating')
export class OperatingStreamController {
  constructor(
    private readonly vehicles: OperatingVehiclesService,
    private readonly cargo: OperatingCargoService,
    private readonly areas: OperatingAreasService,
    private readonly orders: OperatingOrdersService,
    private readonly mapSync: OperatingMapSyncService,
    private readonly tasks: OperatingTasksService,
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly permissions: PermissionsService,
  ) {}

  @Sse('stream')
  stream(@CurrentUser() user: AuthUser): Observable<MessageEvent> {
    return merge(
      this.vehicles.updates$.pipe(
        map((dto) => ({ data: { kind: 'vehicle', payload: dto } })),
        catchError(() => EMPTY),
      ),
      this.cargo.changes$.pipe(
        map(() => ({ data: { kind: 'cargo' } })),
        catchError(() => EMPTY),
      ),
      this.areas.changes$.pipe(
        map(() => ({ data: { kind: 'area' } })),
        catchError(() => EMPTY),
      ),
      this.orders.changes$.pipe(
        map((order) => ({ data: { kind: 'order', payload: order } })),
        catchError(() => EMPTY),
      ),
      this.tasks.changes$.pipe(
        map(() => ({ data: { kind: 'task' } })),
        catchError(() => EMPTY),
      ),
      this.mapSync.changes$.pipe(
        map(() => ({ data: { kind: 'map' } })),
        catchError(() => EMPTY),
      ),
      sseHeartbeat$(
        SSE_HEARTBEAT_MS,
        this.users,
        this.tokens,
        this.permissions,
        user,
      ),
    );
  }
}
