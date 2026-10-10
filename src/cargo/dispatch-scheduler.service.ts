import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LegReconcileService } from './leg-reconcile.service';
import { OrderRecreationService } from './order-recreation.service';
import { TaskOrderReconcileService } from './task-order-reconcile.service';
import { ReleaseEngineService } from './release-engine.service';
import { AssignmentEngineService } from './assignment-engine.service';
import { ChargeEngineService } from './charge-engine.service';
import { ChargeRecallService } from './charge-recall.service';
import { OrphanOrderSweeper } from './orphan-order.sweeper';
import { ParkingEngineService } from './parking-engine.service';
import { ParkClaimStore } from './park-claim.store';
import {
  FMS_EVENTS,
  KERNEL_SESSION_EVENTS,
  TRANSPORT_TASK_EVENTS,
  ZONE_EVENTS,
} from './domain/events';
import { KernelSessionService } from '../kernel-session/kernel-session.service';

const DEBOUNCE_MS = 1_500;
const MAX_WAIT_MS = 3_500;

@Injectable()
export class DispatchSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DispatchSchedulerService.name);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private burstStartedAt: number | null = null;
  private isFlushing = false;
  private rerunWanted = false;

  constructor(
    private readonly legReconcile: LegReconcileService,
    private readonly orderRecreation: OrderRecreationService,
    private readonly releaseEngine: ReleaseEngineService,
    private readonly assignmentEngine: AssignmentEngineService,
    private readonly chargeEngine: ChargeEngineService,
    private readonly parkingEngine: ParkingEngineService,
    private readonly parkClaims: ParkClaimStore,
    private readonly taskOrderReconcile: TaskOrderReconcileService,
    private readonly chargeRecall: ChargeRecallService,
    private readonly orphanOrders: OrphanOrderSweeper,
    private readonly kernelSession: KernelSessionService,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule();
  }

  @OnEvent(TRANSPORT_TASK_EVENTS.CREATED)
  @OnEvent(TRANSPORT_TASK_EVENTS.STATUS_CHANGED)
  @OnEvent(FMS_EVENTS.VEHICLE_AVAILABLE)
  @OnEvent(ZONE_EVENTS.SLOT_RELEASED)
  @OnEvent(KERNEL_SESSION_EVENTS.READY)
  onDispatchTrigger(event: unknown): void {
    this.logger.debug(
      `Dispatch trigger: ${(event as { constructor?: { name?: string } })?.constructor?.name ?? typeof event}`,
    );
    this.schedule();
  }

  schedule(): void {
    const now = Date.now();
    this.burstStartedAt ??= now;
    const remainingBudget = MAX_WAIT_MS - (now - this.burstStartedAt);
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, remainingBudget));

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.burstStartedAt = null;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (!this.kernelSession.isReady()) {
      this.logger.debug('Dispatch frozen — the kernel is not ready');
      return;
    }
    if (this.isFlushing) {
      this.rerunWanted = true;
      return;
    }
    this.isFlushing = true;
    try {
      await this.parkClaims.reconcile();
      await this.legReconcile.run();
      await this.orderRecreation.run();
      await this.taskOrderReconcile.run();
      await this.orphanOrders.run();
      await this.releaseEngine.run();
      await this.assignmentEngine.run();
      await this.chargeRecall.run();
      await this.chargeEngine.run();
      await this.parkingEngine.run();
    } catch (err) {
      this.logger.error(
        `Flush failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    } finally {
      this.isFlushing = false;
      if (this.rerunWanted) {
        this.rerunWanted = false;
        this.schedule();
      }
    }
  }
}
