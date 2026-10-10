import {
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, Subject } from 'rxjs';
import { KernelApiService } from '../../opentcs/kernel-api.service';
import {
  FMS_EVENTS,
  TASK_ORDER_EVENTS,
  TaskOrderChangedEvent,
} from '../../cargo/domain/events';
import { TaskOrderService } from '../../cargo/task-order.service';
import { ActiveMapContext } from '../../maps/infrastructure/active-map-context.service';
import {
  toOrderDetailFromLedger,
  toOrderDtoFromLedger,
} from '../domain/ledger-order-view';
import type { TransportOrderDto } from '../dto/operating.dto';
import {
  computeRouteProgress,
  type RawOrder,
  type RouteProgress,
  type RouteStep,
} from '../domain/route-progress';
import { LatestWins } from '../realtime/latest-wins';
import {
  OrderRetention,
  type OrderRetentionLimits,
  type OrderRetentionOp,
} from '../realtime/order-retention';

export type { RouteProgress, RouteStep };

/** How long a vehicle's remaining route point list is reused before re-fetching the order. */
const ROUTE_POINTS_TTL_MS = 1_500;
/** Order names are one-shot (a fresh UUID/task-derived name per order, never reused), so the
 *  cache only ever grows — bound it so a long-running process doesn't accumulate one entry per
 *  order ever issued. */
const ROUTE_PROGRESS_CACHE_MAX = 500;
const RETENTION_SWEEP_MS = 30_000;
const DEFAULT_RECENT_TERMINAL_MAX = 100;
const DEFAULT_RECENT_TERMINAL_TTL_MS = 15 * 60_000;

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function orderRetentionLimits(): OrderRetentionLimits {
  return {
    maxRecentTerminal: positiveEnv(
      'OPERATING_RECENT_TERMINAL_MAX',
      DEFAULT_RECENT_TERMINAL_MAX,
    ),
    recentTerminalTtlMs: positiveEnv(
      'OPERATING_RECENT_TERMINAL_TTL_MS',
      DEFAULT_RECENT_TERMINAL_TTL_MS,
    ),
  };
}

/**
 * Read model of the transport orders for the operating screen, projected from the order ledger
 * (`transport_request_orders`): every order still open plus a bounded window of the ones that just
 * ended (`OrderRetention`). It follows the ledger's change events and never lists the kernel's
 * order pool, so how long the kernel keeps finished orders does not matter here. The kernel is
 * asked only for what it alone knows — the remaining route of an order a vehicle is driving.
 */
@Injectable()
export class OperatingOrdersService implements OnModuleInit, OnModuleDestroy {
  private readonly routeProgressCache = new Map<
    string,
    { value: RouteProgress; at: number }
  >();
  /** Coalesces concurrent cache-misses for the same order into one kernel call — every vehicle
   *  SSE subscriber calls `routeProgress` independently, so without this an N-subscriber tab
   *  count turns into N kernel reads per event on a cold/expired cache entry. */
  private readonly inFlight = new Map<string, Promise<RouteProgress>>();
  private readonly ticks = new Subject<TransportOrderDto>();
  private readonly ops = new Subject<OrderRetentionOp>();
  private readonly retention = new OrderRetention(orderRetentionLimits());
  private readonly changeOrder = new LatestWins();
  private primed = false;
  private priming: Promise<void> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private readonly limits = orderRetentionLimits();

  constructor(
    private readonly kernelApi: KernelApiService,
    private readonly taskOrders: TaskOrderService,
    private readonly activeMap: ActiveMapContext,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(
      () => this.publish(this.retention.sweep(Date.now())),
      RETENTION_SWEEP_MS,
    );
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Fires the changed order's DTO whenever a kernel transport order's state actually changes —
   *  the legacy `/operating/stream` patches just that row from it. */
  get changes$(): Observable<TransportOrderDto> {
    return this.ticks.asObservable();
  }

  /** Upserts and removals of the retained set, in the order they were applied. */
  get retainedOps$(): Observable<OrderRetentionOp> {
    return this.ops.asObservable();
  }

  @OnEvent(TASK_ORDER_EVENTS.CHANGED)
  async onLedgerOrderChanged(event: TaskOrderChangedEvent): Promise<void> {
    const token = this.changeOrder.begin(event.orderName);
    const row = await this.taskOrders.findByOrderName(event.orderName);
    if (!this.changeOrder.settle(event.orderName, token)) return;
    if (!row) {
      this.publish(this.retention.remove(event.orderName));
      return;
    }
    const order = toOrderDtoFromLedger(row);
    this.ticks.next(order);
    this.publish(this.retention.apply(order, Date.now()));
  }
  @OnEvent(FMS_EVENTS.KERNEL_CONNECTED)
  async onKernelConnected(): Promise<void> {
    await this.reconcile().catch(() => undefined);
  }

  /** The kernel now runs another plant model: nothing retained belongs to it. */
  async resetForNewMap(): Promise<void> {
    this.retention.clear();
    this.primed = false;
    await this.reconcile().catch(() => undefined);
  }

  async list(): Promise<TransportOrderDto[]> {
    if (!this.primed) await this.reconcile();
    return this.retention.list();
  }

  retained(): TransportOrderDto[] {
    return this.retention.list();
  }

  counts(): { active: number; processing: number; recentTerminal: number } {
    return this.retention.counts();
  }

  async get(name: string): Promise<unknown> {
    const [row, live] = await Promise.all([
      this.taskOrders.findByOrderName(name),
      this.kernelApi
        .getTransportOrderRaw(name)
        .then((order) => order as Record<string, unknown> | null)
        .catch(() => null),
    ]);
    if (row) return toOrderDetailFromLedger(row, live);
    if (live) return live;
    throw new NotFoundException('Không tìm thấy lệnh vận chuyển.');
  }

  async routeProgress(orderName: string): Promise<RouteProgress> {
    const cached = this.routeProgressCache.get(orderName);
    if (cached && Date.now() - cached.at < ROUTE_POINTS_TTL_MS)
      return cached.value;

    const running = this.inFlight.get(orderName);
    if (running) return running;

    const promise = this.fetchAndComputeRouteProgress(orderName).finally(() => {
      this.inFlight.delete(orderName);
    });
    this.inFlight.set(orderName, promise);
    return promise;
  }

  private reconcile(): Promise<void> {
    this.priming ??= this.fetchAndReconcile().finally(() => {
      this.priming = null;
    });
    return this.priming;
  }

  private async fetchAndReconcile(): Promise<void> {
    const mapRecordId = await this.activeMap.id();
    const now = Date.now();
    const rows = mapRecordId
      ? (
          await Promise.all([
            this.taskOrders
              .openOrdersOn(mapRecordId, new Date(now))
              .then((open) => open.map(({ row }) => row)),
            this.taskOrders.recentlyEndedOn(
              mapRecordId,
              new Date(now - this.limits.recentTerminalTtlMs),
              this.limits.maxRecentTerminal,
            ),
          ])
        ).flat()
      : [];
    this.primed = true;
    this.publish(this.retention.reconcile(rows.map(toOrderDtoFromLedger), now));
  }

  private publish(ops: readonly OrderRetentionOp[]): void {
    for (const op of ops) this.ops.next(op);
  }

  private async fetchAndComputeRouteProgress(
    orderName: string,
  ): Promise<RouteProgress> {
    const order = (await this.kernelApi
      .getTransportOrderRaw(orderName)
      .catch(() => null)) as RawOrder | null;

    const value = computeRouteProgress(order);
    this.routeProgressCache.set(orderName, { value, at: Date.now() });
    if (this.routeProgressCache.size > ROUTE_PROGRESS_CACHE_MAX) {
      const [oldest] = this.routeProgressCache.keys();
      if (oldest !== undefined) this.routeProgressCache.delete(oldest);
    }
    return value;
  }
}
