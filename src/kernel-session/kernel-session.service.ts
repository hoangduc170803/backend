import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { KernelApiService } from '../opentcs/kernel-api.service';
import { ActiveMapRecordService } from '../maps/infrastructure/active-map-record.service';
import { runWithAdvisoryLock } from '../database/advisory-lock';
import {
  FMS_EVENTS,
  FmsPlantModelReplacedEvent,
  KERNEL_SESSION_EVENTS,
} from '../cargo/domain/events';
import {
  KernelSessionPhase,
  decideSession,
  type KernelProbe,
  type KernelRestoreStep,
  type KernelSessionSnapshot,
  type SessionMemory,
} from './domain/kernel-session';
import {
  epochEntityBody,
  epochEntityName,
  liveEpochNames,
  liveEpochOf,
} from './domain/kernel-epoch';

const RESTORE_LOCK_KEY = 815_004_713;
const DEFAULT_POLL_MS = 3_000;

export abstract class KernelSessionLock {
  abstract run(work: () => Promise<void>): Promise<boolean>;
}

@Injectable()
export class PgKernelSessionLock extends KernelSessionLock {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  run(work: () => Promise<void>): Promise<boolean> {
    return runWithAdvisoryLock(this.dataSource, RESTORE_LOCK_KEY, 0, work);
  }
}

class RestoreStepFailed extends Error {}

@Injectable()
export class KernelSessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KernelSessionService.name);
  private readonly enabled = process.env.KERNEL_SESSION_ENABLED !== 'false';
  private readonly pollMs = positiveInt(
    process.env.KERNEL_SESSION_POLL_MS,
    DEFAULT_POLL_MS,
  );
  private readonly steps: KernelRestoreStep[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private pollAgain = false;
  private memory: SessionMemory = {
    phase: KernelSessionPhase.OFFLINE,
    epoch: null,
    writesInFlight: 0,
    pendingReason: null,
  };
  private current: KernelSessionSnapshot = this.snapshotOf(
    KernelSessionPhase.OFFLINE,
    { step: null, reason: 'Chưa kiểm tra kernel' },
  );

  constructor(
    private readonly kernelApi: KernelApiService,
    private readonly activeMapRecords: ActiveMapRecordService,
    private readonly lock: KernelSessionLock,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn(
        'KERNEL_SESSION_ENABLED=false — WES assumes the kernel is always ready',
      );
      this.transition(KernelSessionPhase.READY, { step: null, reason: null });
      return;
    }
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    void this.poll();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  registerStep(step: KernelRestoreStep): void {
    this.steps.push(step);
    this.steps.sort((a, b) => a.order - b.order);
  }

  isReady(): boolean {
    return this.current.phase === KernelSessionPhase.READY;
  }

  snapshot(): KernelSessionSnapshot {
    return this.current;
  }

  async confirmIntact(): Promise<boolean> {
    if (!this.enabled) return true;
    if (!this.isReady()) return false;
    const probe = await this.probe();
    if (
      probe.reachable &&
      probe.operating &&
      probe.epoch === this.memory.epoch
    ) {
      return true;
    }
    void this.poll();
    return false;
  }

  @OnEvent(FMS_EVENTS.PLANT_MODEL_REPLACING, { promisify: true })
  onPlantModelReplacing(event: FmsPlantModelReplacedEvent): Promise<void> {
    this.memory.writesInFlight++;
    this.memory.pendingReason = `Ghi bản đồ: ${event.reason}`;
    this.transition(KernelSessionPhase.RESTORING, {
      step: null,
      reason: this.memory.pendingReason,
    });
    return Promise.resolve();
  }

  @OnEvent(FMS_EVENTS.PLANT_MODEL_REPLACED, { promisify: true })
  onPlantModelReplaced(event: FmsPlantModelReplacedEvent): Promise<void> {
    this.memory.writesInFlight = Math.max(0, this.memory.writesInFlight - 1);
    this.memory.pendingReason = `Ghi bản đồ: ${event.reason}`;
    void this.poll();
    return Promise.resolve();
  }

  poll(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.polling) {
      this.pollAgain = true;
      return this.polling;
    }
    this.polling = this.pollOnce()
      .catch((err: Error) =>
        this.logger.warn(`Kernel session poll failed: ${err.message}`),
      )
      .finally(() => {
        this.polling = null;
        if (this.pollAgain) {
          this.pollAgain = false;
          void this.poll();
        }
      });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const probe = await this.probe();
    const decision = decideSession(probe, this.memory);
    switch (decision.kind) {
      case 'OFFLINE':
        this.transition(KernelSessionPhase.OFFLINE, {
          step: null,
          reason: 'Không kết nối được kernel',
        });
        return;
      case 'WAIT':
        this.transition(KernelSessionPhase.RESTORING, {
          step: decision.step,
          reason: this.current.reason,
        });
        return;
      case 'READY':
        this.memory.epoch = decision.epoch;
        this.transition(KernelSessionPhase.READY, { step: null, reason: null });
        return;
      case 'RESTORE':
        await this.restoreUnderLock(decision.reason);
        return;
    }
  }

  private async restoreUnderLock(reason: string): Promise<void> {
    const ran = await this.lock.run(() => this.restore(reason));
    if (!ran) {
      this.transition(KernelSessionPhase.RESTORING, {
        step: 'Một tiến trình WES khác đang khôi phục kernel',
        reason,
      });
    }
  }

  private async restore(reason: string): Promise<void> {
    this.transition(KernelSessionPhase.RESTORING, {
      step: 'Xác định bản đồ đang chạy',
      reason,
    });
    const mapRecordId = await this.activeMapRecords.resolveId();
    if (!mapRecordId) {
      this.fail(
        reason,
        'Kernel đang chạy bản đồ WES không nhận ra — nạp lại bản đồ từ WES',
      );
      return;
    }

    for (const [index, step] of this.steps.entries()) {
      this.transition(KernelSessionPhase.RESTORING, {
        step: step.name,
        stepIndex: index + 1,
        reason,
      });
      try {
        await step.run({ mapRecordId, reason });
      } catch (err) {
        this.fail(reason, `${step.name}: ${(err as Error).message}`);
        throw new RestoreStepFailed((err as Error).message);
      }
    }

    const epoch = randomUUID();
    await this.writeEpoch(epoch);
    this.memory.epoch = epoch;
    this.memory.pendingReason = null;
    this.logger.log(`Kernel restored (${reason}) — epoch ${epoch}`);
    this.transition(KernelSessionPhase.READY, { step: null, reason: null });
    this.events.emit(KERNEL_SESSION_EVENTS.READY, this.current);
  }

  private async writeEpoch(epoch: string): Promise<void> {
    const stale = liveEpochNames(
      await this.kernelApi.listEnvironmentalEntities(),
    );
    for (const name of stale) {
      await this.kernelApi.retireEnvironmentalEntity(name);
    }
    await this.kernelApi.createEnvironmentalEntity(
      epochEntityName(epoch),
      epochEntityBody(epoch),
    );
  }

  private async probe(): Promise<KernelProbe> {
    try {
      if (!(await this.kernelApi.isReachable())) {
        return { reachable: false, operating: false, epoch: null };
      }
      let entities: unknown[];
      try {
        entities = await this.kernelApi.listEnvironmentalEntities();
      } catch {
        return { reachable: true, operating: false, epoch: null };
      }
      return { reachable: true, operating: true, epoch: liveEpochOf(entities) };
    } catch {
      return { reachable: false, operating: false, epoch: null };
    }
  }

  private fail(reason: string, message: string): void {
    this.logger.warn(`Kernel restore failed (${reason}): ${message}`);
    this.transition(KernelSessionPhase.RESTORING, {
      step: this.current.step,
      stepIndex: this.current.stepIndex,
      reason,
      lastError: message,
    });
  }

  private transition(
    phase: KernelSessionPhase,
    detail: {
      step: string | null;
      reason: string | null;
      stepIndex?: number;
      lastError?: string | null;
    },
  ): void {
    const previous = this.current;
    const next = this.snapshotOf(phase, detail, previous);
    this.memory.phase = phase;
    this.current = next;
    if (previous.phase !== phase) {
      this.logger.log(
        `Kernel session ${previous.phase} → ${phase}${detail.reason ? ` (${detail.reason})` : ''}`,
      );
    }
    if (
      previous.phase !== next.phase ||
      previous.step !== next.step ||
      previous.lastError !== next.lastError
    ) {
      this.events.emit(KERNEL_SESSION_EVENTS.CHANGED, next);
    }
  }

  private snapshotOf(
    phase: KernelSessionPhase,
    detail: {
      step: string | null;
      reason: string | null;
      stepIndex?: number;
      lastError?: string | null;
    },
    previous?: KernelSessionSnapshot,
  ): KernelSessionSnapshot {
    const samePhase = previous?.phase === phase;
    return {
      phase,
      step: detail.step,
      stepIndex: detail.stepIndex ?? 0,
      stepCount: this.steps?.length ?? 0,
      reason: detail.reason,
      lastError:
        detail.lastError !== undefined
          ? detail.lastError
          : phase === KernelSessionPhase.READY
            ? null
            : (previous?.lastError ?? null),
      epoch: this.memory?.epoch ?? null,
      since: samePhase && previous ? previous.since : new Date().toISOString(),
    };
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}
