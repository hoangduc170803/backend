import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import type { KernelVehicleState } from './domain/kernel-model';
import { SseSessionEntity } from './entities/sse-session.entity';
import { VehicleStateTransitionEntity } from './entities/vehicle-state-transition.entity';
import { VehicleStateStore } from './vehicle-state.store';

const FLUSH_INTERVAL_MS = 1_500;
/** Cap on requeued + newly recorded rows while flushing keeps failing (DB down) — bounds memory
 *  instead of buffering every vehicle transition for the entire outage. Beyond this, the oldest
 *  rows are dropped in favor of newer ones. */
const BUFFER_MAX_ROWS = 5_000;

interface VehicleSnapshot {
  point: string | null;
  procState: string;
  state: string;
  order: string | null;
  goalOrder: string | null;
  orderCreatedAt: string | null;
  goalReceivedAt: string | null;
}

type PendingRow = Omit<
  VehicleStateTransitionEntity,
  'id' | 'sessionId' | 'occurredAt' | 'mapRecordId'
>;

@Injectable()
export class FleetTelemetryService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(FleetTelemetryService.name);

  private sessionId: string | null = null;
  private readonly last = new Map<string, VehicleSnapshot>();
  private buffer: PendingRow[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private subscription: Subscription | null = null;
  private flushing = false;

  constructor(
    @InjectRepository(SseSessionEntity)
    private readonly sessionRepo: Repository<SseSessionEntity>,
    @InjectRepository(VehicleStateTransitionEntity)
    private readonly transitionRepo: Repository<VehicleStateTransitionEntity>,
    private readonly vehicleStore: VehicleStateStore,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  onModuleInit(): void {
    this.subscription = this.vehicleStore.vehicleUpdates.subscribe((state) =>
      this.record(state),
    );
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.subscription?.unsubscribe();
    await this.closeSession('app shutdown');
  }

  async openSession(): Promise<void> {
    await this.closeSession('superseded by new connection');
    await this.reapOrphanedSessions();
    try {
      const session = await this.sessionRepo.save(this.sessionRepo.create({}));
      this.sessionId = String(session.id);
      this.last.clear();
      this.logger.log(`SSE session ${this.sessionId} opened`);
    } catch (err) {
      this.logger.error(
        `Failed to open SSE session: ${(err as Error).message}`,
      );
    }
  }

  private async reapOrphanedSessions(): Promise<void> {
    try {
      const reaped = await this.sessionRepo.update(
        { endedAt: IsNull() },
        { endedAt: new Date(), endReason: 'orphaned (process exit)' },
      );
      if (reaped.affected && reaped.affected > 1) {
        this.logger.warn(
          `Reaped ${reaped.affected} orphaned SSE session(s) — more than one was open, a previous listener leaked`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to reap orphaned SSE sessions: ${(err as Error).message}`,
      );
    }
  }

  async closeSession(reason: string): Promise<void> {
    const id = this.sessionId;
    if (!id) return;
    this.sessionId = null;
    await this.flush(id);
    try {
      await this.sessionRepo.update(id, {
        endedAt: new Date(),
        endReason: reason.slice(0, 100),
      });
      this.logger.log(`SSE session ${id} closed (${reason})`);
    } catch (err) {
      this.logger.error(
        `Failed to close SSE session ${id}: ${(err as Error).message}`,
      );
    }
  }

  private record(state: KernelVehicleState): void {
    const snapshot: VehicleSnapshot = {
      point: state.currentPosition ?? null,
      procState: state.procState,
      state: state.state,
      order: state.transportOrder ?? null,
      goalOrder: state.goal?.orderName ?? null,
      orderCreatedAt: state.goal?.creationTime ?? null,
      goalReceivedAt: state.goal?.receivedAt ?? null,
    };
    const previous = this.last.get(state.name);
    if (
      previous &&
      previous.point === snapshot.point &&
      previous.procState === snapshot.procState &&
      previous.state === snapshot.state &&
      previous.order === snapshot.order &&
      previous.goalOrder === snapshot.goalOrder &&
      previous.orderCreatedAt === snapshot.orderCreatedAt &&
      previous.goalReceivedAt === snapshot.goalReceivedAt
    ) {
      return; // SSE re-sent an unchanged state — not a transition.
    }
    this.last.set(state.name, snapshot);
    this.buffer.push({
      vehicleName: state.name,
      pointName: snapshot.point,
      procState: snapshot.procState,
      vehicleState: snapshot.state,
      orderName: snapshot.order,
      goalOrderName: snapshot.goalOrder,
      orderCreatedAt: snapshot.orderCreatedAt
        ? new Date(snapshot.orderCreatedAt)
        : null,
      goalReceivedAt: snapshot.goalReceivedAt
        ? new Date(snapshot.goalReceivedAt)
        : null,
      observedAt: state.observedAt ? new Date(state.observedAt) : null,
    });
  }

  private async flush(
    sessionId: string | null = this.sessionId,
  ): Promise<void> {
    if (!sessionId || this.buffer.length === 0 || this.flushing) return;
    this.flushing = true;
    const rows = this.buffer;
    this.buffer = [];
    try {
      const mapRecordId = await this.loadedMapId();
      await this.transitionRepo.insert(
        rows.map((row) => ({
          ...row,
          sessionId,
          mapRecordId,
          occurredAt: () => 'now()',
        })),
      );
    } catch (err) {
      this.logger.error(
        `Failed to flush ${rows.length} vehicle transition(s), requeueing for next attempt: ${(err as Error).message}`,
      );
      this.buffer = [...rows, ...this.buffer];
      if (this.buffer.length > BUFFER_MAX_ROWS) {
        const dropped = this.buffer.length - BUFFER_MAX_ROWS;
        this.buffer = this.buffer.slice(dropped);
        this.logger.warn(
          `Telemetry buffer exceeded ${BUFFER_MAX_ROWS} rows during a sustained flush failure — dropped the oldest ${dropped}`,
        );
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * The map loaded in openTCS — stamped on every row so same-named vehicles of different maps
   * keep separate histories. Resolved lazily: `MapRecordCoreModule` imports this module, so the
   * context cannot be constructor-injected here.
   */
  private async loadedMapId(): Promise<string | null> {
    try {
      return (
        (await this.moduleRef?.get(ActiveMapContext, { strict: false }).id()) ??
        null
      );
    } catch {
      return null;
    }
  }
}
