import {
  Controller,
  Get,
  Headers,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Subscription, map, merge } from 'rxjs';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthUser } from '../../auth/jwt-payload';
import { PermissionsService } from '../../auth/permissions.service';
import { sseHeartbeat$ } from '../../auth/sse-heartbeat';
import { TokenService } from '../../auth/token.service';
import { ActiveMapContext } from '../../maps/infrastructure/active-map-context.service';
import { UsersService } from '../../users/users.service';
import {
  OperatingProjectionService,
  type StreamFrame,
} from '../realtime/operating-projection.service';
import { emptySummary } from '../realtime/operating-summary.service';
import type { OperatingSummaryDto } from '../realtime/projection-event';

const SSE_HEARTBEAT_MS = 15_000;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const PING_FRAME: StreamFrame = { kind: 'ping', data: '' };

function encode(frame: StreamFrame): string {
  if (frame.kind === 'ping') return 'event: ping\ndata: \n\n';
  const id = frame.id ? `id: ${frame.id}\n` : '';
  return `${id}data: ${frame.data}\n\n`;
}

@ApiTags('operating')
@UseGuards(JwtAuthGuard)
@Controller('operating')
export class OperatingStreamV2Controller {
  constructor(
    private readonly projection: OperatingProjectionService,
    private readonly activeMap: ActiveMapContext,
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly permissions: PermissionsService,
  ) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Bộ đếm màn Vận hành',
    description:
      'Số lệnh, nhiệm vụ, hàng và vật cản của bản đồ đang nạp — cho thanh trạng thái và nhãn tab, ' +
      'không cần tải danh sách. Vai trò không có bản đồ đang nạp trong phạm vi nhận toàn số 0. ' +
      'Cùng dữ liệu được đẩy qua `GET /operating/stream/v2` (kind `summary`). Chỉ cần đăng nhập.',
  })
  @ApiOkResponse({
    description:
      '`orders` (active / processing / recentTerminal), `tasks.byStatus`, `cargos.byStatus`, `obstacles`.',
  })
  async summary(@CurrentUser() user: AuthUser): Promise<OperatingSummaryDto> {
    return (await this.inScope(user))
      ? this.projection.currentSummary()
      : emptySummary();
  }

  @Get('stream/v2')
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Luồng realtime màn Vận hành (snapshot + delta)',
    description:
      'Server-Sent Events. Mở không có `cursor` (hoặc cursor đã quá hạn / khác epoch): nhận ảnh chụp ' +
      'đối tượng đang hoạt động theo từng khối (`snapshot-begin` … `snapshot-end`), rồi delta. ' +
      'Ảnh chụp gồm xe, lệnh, và toàn bộ nhiệm vụ / hàng / khu vực / vật cản của bản đồ đang nạp ' +
      '(cùng dữ liệu với `GET /operating/tasks`, `/cargo`, `/areas`, `/environmental-entities`), kèm `footprint` của hàng. ' +
      'Mỗi delta mang `epoch`, `seq`, `kind` (vehicle / order / task / cargo / area / obstacle / summary / map), ' +
      '`op` (upsert / patch / remove / reset) và `rev` của đối tượng; `id` của sự kiện là `epoch:seq`. ' +
      'Nhiệm vụ, hàng, khu vực và vật cản chỉ phát `upsert` / `remove` của đúng đối tượng đã đổi, không phát lại cả danh sách. ' +
      'Kết nối lại với `cursor` (hoặc header `Last-Event-ID`) còn trong bộ đệm phát lại thì chỉ nhận phần thiếu. ' +
      'Đổi bản đồ phát `map reset` và sang epoch mới. Vai trò không có bản đồ đang nạp trong phạm vi chỉ nhận `map reset`. ' +
      'Kết nối bị đóng khi bộ đệm gửi vượt 4 MiB; client kết nối lại và đồng bộ. Chỉ cần đăng nhập.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Sự kiện cuối đã nhận, dạng `epoch:seq`.',
  })
  @ApiOkResponse({ description: 'Luồng `text/event-stream`.' })
  async stream(
    @CurrentUser() user: AuthUser,
    @Query('cursor') cursor: string | undefined,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const inScope = await this.inScope(user);
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    let subscription: Subscription | null = null;
    let closed = false;
    const close = (abandonUnsent = false): void => {
      if (closed) return;
      closed = true;
      subscription?.unsubscribe();
      if (abandonUnsent) response.destroy();
      else response.end();
    };
    const frames$ = inScope
      ? this.projection.open(cursor ?? lastEventId)
      : this.projection.openMapOnly();
    const heartbeat$ = sseHeartbeat$(
      SSE_HEARTBEAT_MS,
      this.users,
      this.tokens,
      this.permissions,
      user,
    ).pipe(map(() => PING_FRAME));

    subscription = merge(frames$, heartbeat$).subscribe({
      next: (frame) => {
        if (closed) return;
        response.write(encode(frame));
        if (response.writableLength > MAX_BUFFERED_BYTES) close(true);
      },
      error: () => close(),
      complete: () => close(),
    });
    if (closed) subscription.unsubscribe();
    request.on('close', () => close());
  }

  private async inScope(user: AuthUser): Promise<boolean> {
    if (user.mapIds === undefined) return true;
    const activeMapId = await this.activeMap.id();
    return activeMapId !== null && user.mapIds.includes(activeMapId);
  }
}
