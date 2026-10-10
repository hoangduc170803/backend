import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, Subject, Subscription } from 'rxjs';
import {
  ENVIRONMENTAL_ENTITY_EVENTS,
  FMS_EVENTS,
} from '../../cargo/domain/events';
import { EnvironmentalEntitySyncService } from '../../environmental-entities/environmental-entity-sync.service';
import { ActiveMapContext } from '../../maps/infrastructure/active-map-context.service';
import type { KernelVehicleState } from '../../opentcs/domain/kernel-model';
import { OperatingAreasService } from '../application/operating-areas.service';
import { OperatingCargoService } from '../application/operating-cargo.service';
import { OperatingOrdersService } from '../application/operating-orders.service';
import { OperatingTasksService } from '../application/operating-tasks.service';
import { OperatingVehiclesService } from '../application/operating-vehicles.service';
import type {
  AreaDto,
  CargoDto,
  TaskDto,
  TransportOrderDto,
  VehicleRealtimeDto,
} from '../dto/operating.dto';
import type { EnvironmentalEntityOverlayDto } from '../../environmental-entities/environmental-entity.dto';
import { CoalescedTask } from './coalesced-task';
import { LatestWins } from './latest-wins';
import { ListProjection } from './list-projection';
import {
  OperatingSummaryService,
  emptySummary,
} from './operating-summary.service';
import type { OrderRetentionOp } from './order-retention';
import {
  PROJECTION_TOPICS,
  SNAPSHOT_CHUNK_SIZE,
  cursorOf,
  parseCursor,
  type ListPayload,
  type OperatingSummaryDto,
  type ProjectionChange,
  type ProjectionTopic,
  type SessionFrame,
  type SnapshotItem,
} from './projection-event';
import { ReplayLog } from './replay-log';
import { diffVehicle } from './vehicle-diff';

const TELEMETRY_FLUSH_MS = 100;
const LIST_COALESCE_MS = 150;
const SUMMARY_COALESCE_MS = 500;
const SUMMARY_SAFETY_REFRESH_MS = 60_000;
const LIST_SAFETY_REFRESH_MS = 60_000;
const REPLAY_MAX_ENTRIES = 5_000;
const REPLAY_MAX_BYTES = 8 * 1024 * 1024;

export interface StreamFrame {
  id?: string;
  kind: string;
  data: string;
}

export interface ProjectionStats {
  epoch: string;
  seq: number;
  sessions: number;
  vehicles: number;
  orders: number;
  replayEntries: number;
  replayBytes: number;
}

interface PublishedVehicle {
  rev: number;
  dto: VehicleRealtimeDto;
}

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

function chunksOrOneEmpty<T>(items: readonly T[], size: number): T[][] {
  const chunks = chunksOf(items, size);
  return chunks.length > 0 ? chunks : [[]];
}

@Injectable()
export class OperatingProjectionService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(OperatingProjectionService.name);
  private readonly bootId = Date.now().toString(36);
  private generation = 0;
  private epoch = this.epochOf(0);
  private seq = 0;
  private sessions = 0;
  private readonly live = new Subject<StreamFrame>();
  private readonly replay = new ReplayLog({
    maxEntries: REPLAY_MAX_ENTRIES,
    maxBytes: REPLAY_MAX_BYTES,
  });
  private readonly published = new Map<string, PublishedVehicle>();
  private readonly pendingTelemetry = new Map<string, VehicleRealtimeDto>();
  private readonly vehicleOrder = new LatestWins();
  private readonly orderRevs = new Map<string, number>();
  private readonly lists: Record<ProjectionTopic, ListProjection<ListPayload>> =
    {
      task: new ListProjection((item) => (item as TaskDto).taskId),
      cargo: new ListProjection((item) => (item as CargoDto).cargoId),
      area: new ListProjection((item) => (item as AreaDto).wesId),
      obstacle: new ListProjection(
        (item) => (item as EnvironmentalEntityOverlayDto).cargoId,
      ),
    };
  private readonly listLoaders: Record<
    ProjectionTopic,
    () => Promise<readonly ListPayload[]>
  > = {
    task: async () => (await this.tasks.list()).tasks,
    cargo: async () => (await this.cargo.list()).cargos,
    area: () => this.areas.list(),
    obstacle: async () => this.obstacles.overlayFor(await this.activeMap.id()),
  };
  private readonly listRefreshes: Record<ProjectionTopic, CoalescedTask> = {
    task: this.listRefreshOf('task'),
    cargo: this.listRefreshOf('cargo'),
    area: this.listRefreshOf('area'),
    obstacle: this.listRefreshOf('obstacle'),
  };
  private summary: { rev: number; payload: OperatingSummaryDto; json: string } =
    { rev: 0, payload: emptySummary(), json: '' };
  private summaryRunning = false;
  private summaryStale = false;
  private telemetryTimer: ReturnType<typeof setTimeout> | null = null;
  private summaryTimer: ReturnType<typeof setTimeout> | null = null;
  private summarySafetyTimer: ReturnType<typeof setInterval> | null = null;
  private listSafetyTimer: ReturnType<typeof setInterval> | null = null;
  private subscriptions: Subscription[] = [];

  constructor(
    private readonly vehicles: OperatingVehiclesService,
    private readonly orders: OperatingOrdersService,
    private readonly tasks: OperatingTasksService,
    private readonly cargo: OperatingCargoService,
    private readonly areas: OperatingAreasService,
    private readonly summaries: OperatingSummaryService,
    private readonly obstacles: EnvironmentalEntitySyncService,
    private readonly activeMap: ActiveMapContext,
  ) {}

  onModuleInit(): void {
    this.subscriptions = [
      this.vehicles.states$.subscribe(
        (state) => void this.onVehicleState(state),
      ),
      this.orders.retainedOps$.subscribe((op) => this.onOrderOp(op)),
      this.tasks.changes$.subscribe(() => this.markDirty('task')),
      this.cargo.changes$.subscribe(() => this.markDirty('cargo')),
      this.areas.changes$.subscribe(() => this.markDirty('area')),
    ];
    void this.primeVehicles();
    this.refreshEveryList();
    this.scheduleSummary();
    this.summarySafetyTimer = setInterval(
      () => this.scheduleSummary(),
      SUMMARY_SAFETY_REFRESH_MS,
    );
    this.summarySafetyTimer.unref();
    this.listSafetyTimer = setInterval(
      () => this.refreshEveryList(),
      LIST_SAFETY_REFRESH_MS,
    );
    this.listSafetyTimer.unref();
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    if (this.summarySafetyTimer) clearInterval(this.summarySafetyTimer);
    if (this.listSafetyTimer) clearInterval(this.listSafetyTimer);
    for (const timer of [this.telemetryTimer, this.summaryTimer]) {
      if (timer) clearTimeout(timer);
    }
    for (const topic of PROJECTION_TOPICS) this.listRefreshes[topic].cancel();
    this.live.complete();
  }

  @OnEvent(ENVIRONMENTAL_ENTITY_EVENTS.CHANGED)
  onObstacleChanged(): void {
    this.markDirty('obstacle');
  }

  @OnEvent(FMS_EVENTS.KERNEL_CONNECTED)
  async onKernelConnected(): Promise<void> {
    await this.primeVehicles();
    this.refreshEveryList();
    this.scheduleSummary();
  }

  @OnEvent(FMS_EVENTS.MAP_LOADED)
  async onMapLoaded(): Promise<void> {
    this.generation += 1;
    this.epoch = this.epochOf(this.generation);
    this.seq = 0;
    this.replay.clear();
    this.published.clear();
    this.pendingTelemetry.clear();
    this.orderRevs.clear();
    for (const topic of PROJECTION_TOPICS) this.lists[topic].clear();
    this.live.next({
      kind: 'map',
      data: JSON.stringify({ kind: 'map', op: 'reset' }),
    });
    await this.orders.resetForNewMap();
    await this.primeVehicles();
    this.refreshEveryList();
    this.scheduleSummary();
  }

  open(cursor: string | null | undefined): Observable<StreamFrame> {
    return new Observable<StreamFrame>((subscriber) => {
      for (const frame of this.openingFrames(cursor)) subscriber.next(frame);
      this.sessions += 1;
      const subscription = this.live.subscribe(subscriber);
      return () => {
        this.sessions -= 1;
        subscription.unsubscribe();
      };
    });
  }

  openMapOnly(): Observable<StreamFrame> {
    return new Observable<StreamFrame>((subscriber) => {
      const subscription = this.live.subscribe({
        next: (frame) => {
          if (frame.kind === 'map') subscriber.next(frame);
        },
        error: (error) => subscriber.error(error),
        complete: () => subscriber.complete(),
      });
      return () => subscription.unsubscribe();
    });
  }

  currentSummary(): OperatingSummaryDto {
    return this.summary.payload;
  }

  stats(): ProjectionStats {
    return {
      epoch: this.epoch,
      seq: this.seq,
      sessions: this.sessions,
      vehicles: this.published.size,
      orders: this.orderRevs.size,
      replayEntries: this.replay.size,
      replayBytes: this.replay.retainedBytes,
    };
  }

  private epochOf(generation: number): string {
    return `${this.bootId}.${generation}`;
  }

  private openingFrames(cursor: string | null | undefined): StreamFrame[] {
    const resumeFrom = parseCursor(cursor);
    const missed =
      resumeFrom && resumeFrom.epoch === this.epoch
        ? this.replay.since(resumeFrom.seq, this.seq)
        : null;
    if (missed) {
      return [
        this.sessionFrame({
          kind: 'session',
          op: 'resume',
          epoch: this.epoch,
          seq: this.seq,
        }),
        ...missed.map((entry) => ({
          id: cursorOf(this.epoch, entry.seq),
          kind: 'replay',
          data: entry.data,
        })),
      ];
    }
    return this.snapshotFrames();
  }

  private snapshotFrames(): StreamFrame[] {
    const vehicleItems: SnapshotItem<VehicleRealtimeDto>[] = [
      ...this.published,
    ].map(([id, { rev, dto }]) => ({ id, rev, payload: dto }));
    const orderItems: SnapshotItem<TransportOrderDto>[] = this.orders
      .retained()
      .map((order) => ({
        id: order.name,
        rev: this.orderRevs.get(order.name) ?? 0,
        payload: order,
      }));
    const mark = { epoch: this.epoch, seq: this.seq };
    const frames: SessionFrame[] = [
      { kind: 'session', op: 'snapshot-begin', ...mark },
      ...chunksOf(vehicleItems, SNAPSHOT_CHUNK_SIZE).map(
        (items): SessionFrame => ({ kind: 'vehicle', op: 'snapshot', items }),
      ),
      ...chunksOf(orderItems, SNAPSHOT_CHUNK_SIZE).map(
        (items): SessionFrame => ({ kind: 'order', op: 'snapshot', items }),
      ),
      ...PROJECTION_TOPICS.flatMap((topic) =>
        chunksOrOneEmpty(this.lists[topic].snapshot(), SNAPSHOT_CHUNK_SIZE).map(
          (items): SessionFrame => ({ kind: topic, op: 'snapshot', items }),
        ),
      ),
      {
        kind: 'footprint',
        op: 'snapshot',
        payload: this.obstacles.cargoFootprint,
      },
      {
        kind: 'summary',
        op: 'snapshot',
        rev: this.summary.rev,
        payload: this.summary.payload,
      },
      { kind: 'session', op: 'snapshot-end', ...mark },
    ];
    return frames.map((frame) => this.sessionFrame(frame));
  }

  private sessionFrame(frame: SessionFrame): StreamFrame {
    return { kind: frame.kind, data: JSON.stringify(frame) };
  }

  private publish(change: ProjectionChange): void {
    this.seq += 1;
    const data = JSON.stringify({
      ...change,
      epoch: this.epoch,
      seq: this.seq,
    });
    this.replay.append({ seq: this.seq, data });
    this.live.next({
      id: cursorOf(this.epoch, this.seq),
      kind: change.kind,
      data,
    });
  }

  private async primeVehicles(): Promise<void> {
    const generation = this.generation;
    const states = await this.vehicles
      .currentStates()
      .catch((): KernelVehicleState[] => []);
    if (generation !== this.generation) return;
    await Promise.all(states.map((state) => this.onVehicleState(state)));
  }

  private async onVehicleState(state: KernelVehicleState): Promise<void> {
    const generation = this.generation;
    const token = this.vehicleOrder.begin(state.name);
    let dto: VehicleRealtimeDto | null = null;
    try {
      dto = await this.vehicles.enrich(state);
    } catch (error) {
      this.logger.warn(
        `Vehicle ${state.name} could not be projected: ${(error as Error).message}`,
      );
    }
    const isNewest = this.vehicleOrder.settle(state.name, token);
    if (!dto || !isNewest || generation !== this.generation) return;
    this.applyVehicle(dto);
  }

  private applyVehicle(dto: VehicleRealtimeDto): void {
    const known = this.published.get(dto.name);
    if (!known) {
      this.published.set(dto.name, { rev: 1, dto });
      this.publish({
        kind: 'vehicle',
        op: 'upsert',
        id: dto.name,
        rev: 1,
        payload: dto,
      });
      return;
    }
    const diff = diffVehicle(known.dto, dto);
    if (!diff.changed) {
      this.pendingTelemetry.delete(dto.name);
      return;
    }
    if (diff.critical) {
      this.pendingTelemetry.delete(dto.name);
      this.publishVehiclePatch(known, dto, diff.changes);
      return;
    }
    this.pendingTelemetry.set(dto.name, dto);
    this.telemetryTimer ??= setTimeout(
      () => this.flushTelemetry(),
      TELEMETRY_FLUSH_MS,
    );
  }

  private flushTelemetry(): void {
    this.telemetryTimer = null;
    const pending = [...this.pendingTelemetry.values()];
    this.pendingTelemetry.clear();
    for (const dto of pending) {
      const known = this.published.get(dto.name);
      if (!known) continue;
      const diff = diffVehicle(known.dto, dto);
      if (diff.changed) this.publishVehiclePatch(known, dto, diff.changes);
    }
  }

  private publishVehiclePatch(
    known: PublishedVehicle,
    dto: VehicleRealtimeDto,
    changes: Partial<VehicleRealtimeDto>,
  ): void {
    known.rev += 1;
    known.dto = dto;
    this.publish({
      kind: 'vehicle',
      op: 'patch',
      id: dto.name,
      rev: known.rev,
      payload: changes,
    });
  }

  private onOrderOp(op: OrderRetentionOp): void {
    const name = op.op === 'upsert' ? op.order.name : op.name;
    const rev = (this.orderRevs.get(name) ?? 0) + 1;
    if (op.op === 'upsert') {
      this.orderRevs.set(name, rev);
      this.publish({
        kind: 'order',
        op: 'upsert',
        id: name,
        rev,
        payload: op.order,
      });
    } else {
      this.orderRevs.delete(name);
      this.publish({ kind: 'order', op: 'remove', id: name, rev });
    }
    this.scheduleSummary();
  }

  private markDirty(topic: ProjectionTopic): void {
    this.listRefreshes[topic].schedule();
    if (topic !== 'area') this.scheduleSummary();
  }

  private refreshEveryList(): void {
    for (const topic of PROJECTION_TOPICS) this.listRefreshes[topic].schedule();
  }

  private listRefreshOf(topic: ProjectionTopic): CoalescedTask {
    return new CoalescedTask(() => this.refreshList(topic), LIST_COALESCE_MS);
  }

  private async refreshList(topic: ProjectionTopic): Promise<void> {
    const generation = this.generation;
    try {
      const items = await this.listLoaders[topic]();
      if (generation !== this.generation) return;
      for (const change of this.lists[topic].apply(items)) {
        this.publish({ kind: topic, ...change });
      }
    } catch (error) {
      this.logger.warn(
        `Operating ${topic} list refresh failed: ${(error as Error).message}`,
      );
    }
  }

  private scheduleSummary(): void {
    if (this.summaryRunning) {
      this.summaryStale = true;
      return;
    }
    this.summaryTimer ??= setTimeout(
      () => void this.refreshSummary(),
      SUMMARY_COALESCE_MS,
    );
  }

  private async refreshSummary(): Promise<void> {
    this.summaryTimer = null;
    this.summaryRunning = true;
    const generation = this.generation;
    try {
      const payload = await this.summaries.compute();
      const json = JSON.stringify(payload);
      if (generation === this.generation && json !== this.summary.json) {
        this.summary = { rev: this.summary.rev + 1, payload, json };
        this.publish({
          kind: 'summary',
          op: 'upsert',
          rev: this.summary.rev,
          payload,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Operating summary refresh failed: ${(error as Error).message}`,
      );
    } finally {
      this.summaryRunning = false;
      if (this.summaryStale) {
        this.summaryStale = false;
        this.scheduleSummary();
      }
    }
  }
}
