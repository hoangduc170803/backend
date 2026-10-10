import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AgvEntity } from '../agvs/entities/agv.entity';
import { thresholdsOf } from '../agvs/domain/battery-thresholds';
import {
  TaskKind,
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { VehicleCandidateService } from './vehicle-candidate.service';
import { TaskTerminationService } from './task-termination.service';
import { ChargeEngineService } from './charge-engine.service';
import { busyTaskWhere } from './task-queries';
import { isEligible } from './domain/dispatch.policy';
import { isRecallableForWork } from './domain/charge.policy';
import { WORK_RECALL_WINDOW_MS } from './charge-engine.constants';

const LIVE_CHARGE_STATUSES = [TaskStatus.CREATED, TaskStatus.EXECUTING];
const RECALL_REASON = 'Nhường xe cho nhiệm vụ giao hàng';

interface RecallCandidate {
  readonly name: string;
  readonly energyLevel: number;
  readonly good: number;
  readonly chargeTask: TransportTaskEntity | null;
}

@Injectable()
export class ChargeRecallService {
  private readonly logger = new Logger(ChargeRecallService.name);
  private readonly recalledAt = new Map<string, number>();

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(AgvEntity)
    private readonly agvRepo: Repository<AgvEntity>,
    private readonly vehicleStore: VehicleStateStore,
    private readonly activeMap: ActiveMapContext,
    private readonly vehicleCandidates: VehicleCandidateService,
    private readonly taskTermination: TaskTerminationService,
    private readonly chargeEngine: ChargeEngineService,
  ) {}

  async run(): Promise<void> {
    const mapRecordId = await this.activeMap.id();
    if (!mapRecordId) return;

    const waitingWork = await this.taskRepo.count({
      where: { status: TaskStatus.READY_TO_ASSIGN, mapRecordId },
    });
    if (waitingWork === 0) {
      this.recalledAt.clear();
      return;
    }

    const busyTasks = await this.busyTasksByVehicle(mapRecordId);
    this.forgetSettledRecalls(busyTasks);

    const candidates = await this.vehicleCandidates.build(
      busyTasks,
      mapRecordId,
    );
    if (candidates.some(isEligible)) return;

    const openSlots = waitingWork - this.recalledAt.size;
    if (openSlots <= 0) return;

    const recallable = await this.recallable(mapRecordId, busyTasks);
    for (const candidate of recallable.slice(0, openSlots)) {
      await this.recall(candidate, waitingWork);
    }
  }

  private async busyTasksByVehicle(
    mapRecordId: string,
  ): Promise<Map<string, TransportTaskEntity>> {
    const tasks = await this.taskRepo.find({
      where: busyTaskWhere(mapRecordId),
    });
    const byVehicle = new Map<string, TransportTaskEntity>();
    for (const task of tasks) {
      const name = task.metadata?.assignedVehicleName;
      if (name && !byVehicle.has(name)) byVehicle.set(name, task);
    }
    return byVehicle;
  }

  private forgetSettledRecalls(
    busyTasks: ReadonlyMap<string, TransportTaskEntity>,
  ): void {
    const now = Date.now();
    for (const [name, at] of [...this.recalledAt]) {
      const tookWork = busyTasks.get(name)?.kind === TaskKind.CARGO;
      if (tookWork || now - at > WORK_RECALL_WINDOW_MS) {
        this.recalledAt.delete(name);
      }
    }
  }

  private async recallable(
    mapRecordId: string,
    busyTasks: ReadonlyMap<string, TransportTaskEntity>,
  ): Promise<RecallCandidate[]> {
    const chargeTasks = await this.taskRepo.find({
      where: {
        kind: TaskKind.CHARGE,
        status: In(LIVE_CHARGE_STATUSES),
        mapRecordId,
      },
    });
    const chargeTaskByVehicle = new Map(
      chargeTasks
        .filter((task) => task.metadata?.assignedVehicleName)
        .map((task) => [task.metadata.assignedVehicleName as string, task]),
    );

    const result: RecallCandidate[] = [];
    for (const agv of await this.agvRepo.find({ where: { mapRecordId } })) {
      if (this.recalledAt.has(agv.name)) continue;
      const fms = this.vehicleStore.get(agv.name);
      const energyLevel = fms?.energyLevel ?? 0;
      const thresholds = thresholdsOf(agv);
      const recallableByPolicy = isRecallableForWork({
        name: agv.name,
        ignored: agv.isIgnored,
        dispatchEnabled: agv.isDispatchEnabled,
        idleAvailable: false,
        enRouteToPark: false,
        charging: fms?.state === 'CHARGING',
        onOrder: fms?.transportOrder != null,
        hasActiveTask: busyTasks.has(agv.name),
        currentPosition: fms?.currentPosition ?? null,
        energyLevel,
        thresholds,
      });
      if (!recallableByPolicy) continue;

      const chargeTask = chargeTaskByVehicle.get(agv.name) ?? null;
      const chargingIdle =
        fms?.state === 'CHARGING' &&
        fms.transportOrder == null &&
        !busyTasks.has(agv.name);
      if (!chargeTask && !chargingIdle) continue;
      result.push({
        name: agv.name,
        energyLevel,
        good: thresholds.good,
        chargeTask,
      });
    }

    return result.sort(
      (a, b) =>
        b.energyLevel - a.energyLevel ||
        Number(!!b.chargeTask) - Number(!!a.chargeTask) ||
        a.name.localeCompare(b.name),
    );
  }

  private async recall(
    candidate: RecallCandidate,
    waitingWork: number,
  ): Promise<void> {
    const context = `${candidate.energyLevel}% ≥ good ${candidate.good}%, ${waitingWork} cargo task(s) waiting and no other vehicle free`;
    const recalled = candidate.chargeTask
      ? await this.cancelChargeTask(candidate.name, candidate.chargeTask)
      : await this.chargeEngine.stopCharging(
          candidate.name,
          `recalled for work — ${context}`,
        );
    if (!recalled) return;
    this.recalledAt.set(candidate.name, Date.now());
    this.logger.log(
      `Work recall: ${candidate.name} ${candidate.chargeTask ? 'charge task cancelled' : 'charging stopped'} — ${context}`,
    );
  }

  private async cancelChargeTask(
    vehicleName: string,
    task: TransportTaskEntity,
  ): Promise<boolean> {
    task.cancelledAt = new Date();
    task.metadata = { ...task.metadata, cancelReason: RECALL_REASON };
    try {
      await this.taskTermination.terminate(task, TaskStatus.CANCELLED, {
        trigger: 'CHARGE_ENGINE',
        reason: RECALL_REASON,
        vehicleName,
      });
      this.chargeEngine.forgetChargeTarget(vehicleName);
      if (this.vehicleStore.get(vehicleName)?.state === 'CHARGING') {
        await this.chargeEngine.stopCharging(vehicleName, RECALL_REASON);
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `${vehicleName}: could not cancel charge task ${task.requestCode} — ${(err as Error).message}`,
      );
      return false;
    }
  }
}
