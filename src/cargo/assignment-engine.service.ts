import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TransportTaskEntity,
  TaskStatus,
} from './entities/transport-task.entity';
import { CargoEntity } from './entities/cargo.entity';
import { PickupDependencyService } from './pickup-dependency.service';
import { DispatchPolicyService } from './dispatch-policy.service';
import {
  DispatchDistanceService,
  type DispatchDistances,
} from './dispatch-distance.service';
import { VehicleCandidateService } from './vehicle-candidate.service';
import { PickupOrderService } from './pickup-order.service';
import { ParkYieldService } from './park-yield.service';
import {
  type DispatchMatcher,
  type DispatchTaskCandidate,
  type VehicleCandidate,
  hasDispatchableVehicle,
  isEligible,
} from './domain/dispatch.policy';
import {
  type DispatchRound,
  counterfactualMatcher,
  planDispatchRound,
} from './domain/dispatch-round';
import {
  comparableCounterfactual,
  summariseDistance,
} from './domain/dispatch-counterfactual';
import type {
  DispatchContext,
  DispatchSession,
} from './assignment-engine.types';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { busyTaskWhere } from './task-queries';
import { DestinationCapacityGate } from './destination-capacity.gate';

@Injectable()
export class AssignmentEngineService {
  private readonly logger = new Logger(AssignmentEngineService.name);

  private readonly matcher: DispatchMatcher;

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    private readonly pickupDependency: PickupDependencyService,
    private readonly dispatchPolicy: DispatchPolicyService,
    private readonly distanceSource: DispatchDistanceService,
    private readonly vehicleCandidates: VehicleCandidateService,
    private readonly pickupOrders: PickupOrderService,
    private readonly activeMap: ActiveMapContext,
    private readonly parkYield: ParkYieldService,
    private readonly destinationCapacity: DestinationCapacityGate,
  ) {
    const requested = process.env.DISPATCH_MATCHER;
    this.matcher = requested === 'greedy' ? 'greedy' : 'hungarian';

    if (requested && requested !== 'greedy' && requested !== 'hungarian') {
      this.logger.warn(
        `DISPATCH_MATCHER="${requested}" is not a known matcher — falling back to hungarian`,
      );
    }
    this.logger.log(
      `Dispatch matcher: ${this.matcher.toUpperCase()} ` +
        `(counterfactual ${counterfactualMatcher(this.matcher).toUpperCase()} recorded on every assignment)`,
    );
  }

  async run(): Promise<void> {
    const session = await this.openSession();
    if (!session) return;

    for (;;) {
      await this.refillPending(session);
      if (session.pending.size === 0) break;
      if (this.freeVehicleCount(session) === 0) break;

      const round = planDispatchRound(
        this.availableCandidates(session),
        [...session.pending.values()].map(toTaskCandidate),
        session.batteryWeight,
        this.matcher,
      );

      if (this.deferUnreachable(session, round)) continue;

      this.logRound(round);
      if (round.assignments.length === 0) break;

      await this.dispatchRound(session, round);
    }
  }

  private async openSession(): Promise<DispatchSession | null> {
    const mapRecordId = await this.activeMap.id();
    if (!mapRecordId) return null;
    const tasks = await this.taskRepo.find({
      where: { status: TaskStatus.READY_TO_ASSIGN, mapRecordId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    if (tasks.length === 0) return null;
    const busyTasks = await this.busyTasksByVehicle(mapRecordId);
    const weights = await this.dispatchPolicy.getActiveWeights();
    const distances = await this.distanceSource.open();
    const candidates = await this.vehicleCandidates.build(
      busyTasks,
      mapRecordId,
    );
    this.logCandidates(tasks.length, candidates);

    const session: DispatchSession = {
      mapRecordId,
      tasks,
      candidates,
      distances,
      batteryWeight: weights?.battery ?? 0,
      pending: new Map(),
      quarantined: new Set(),
      blockedTaskIds: new Set(),
      destinations: await this.destinationCapacity.openRound(mapRecordId),
      cursor: 0,
    };
    if (this.freeVehicleCount(session) === 0) return null;
    return {
      ...session,
      blockedTaskIds: await this.pickupDependency.blockedTaskIds(),
    };
  }

  private availableCandidates(
    session: DispatchSession,
  ): readonly VehicleCandidate[] {
    return session.candidates.filter(
      (candidate) => !session.quarantined.has(candidate.name),
    );
  }

  private freeVehicleCount(session: DispatchSession): number {
    return new Set(
      this.availableCandidates(session)
        .filter(isEligible)
        .map((candidate) => candidate.name),
    ).size;
  }

  private async refillPending(session: DispatchSession): Promise<void> {
    const capacity = this.freeVehicleCount(session);
    while (
      session.pending.size < capacity &&
      session.cursor < session.tasks.length
    ) {
      const task = session.tasks[session.cursor++];

      if (session.blockedTaskIds.has(task.id)) {
        this.logger.debug(`Task ${task.id} blocked at assign time — skipping`);
        continue;
      }

      const context = await this.buildContext(task, session.distances);
      if (!context) continue;
      if (!(await session.destinations.admit(context.cargo))) {
        this.logger.debug(
          `Task ${task.id}: destination zone has no slot left for another load — kept READY`,
        );
        continue;
      }
      session.pending.set(task.id, context);
    }
  }

  private deferUnreachable(
    session: DispatchSession,
    round: DispatchRound,
  ): boolean {
    const planned = new Set(round.assignments.map(({ taskId }) => taskId));
    const candidates = this.availableCandidates(session);

    let deferred = false;
    for (const [taskId, context] of [...session.pending]) {
      if (planned.has(taskId)) continue;
      if (
        hasDispatchableVehicle(candidates, {
          taskId,
          distanceByPoint: context.distanceByPoint,
        })
      ) {
        continue;
      }
      session.pending.delete(taskId);
      this.logger.warn(
        `Task ${taskId} has no reachable eligible vehicle — deferred`,
      );
      deferred = true;
    }
    return deferred;
  }

  private logRound(round: DispatchRound): void {
    this.logger.debug(
      `${round.matcher} plan: ${round.assignments
        .map(
          ({ taskId, vehicle, distance }) =>
            `${taskId}->${vehicle.name}(${distance ?? '?'})`,
        )
        .join(' ')}` +
        ` | counterfactual ${summariseDistance(round.counterfactual)} vs ${summariseDistance(round.assignments)}`,
    );
  }

  private async dispatchRound(
    session: DispatchSession,
    round: DispatchRound,
  ): Promise<void> {
    for (const { taskId, vehicle, distance } of round.assignments) {
      const context = session.pending.get(taskId);
      if (!context) continue;
      session.pending.delete(taskId);

      if (await this.pickupDependency.isBlocked(context.task)) {
        this.logger.debug(`Task ${taskId} blocked before dispatch — skipping`);
        continue;
      }

      await this.parkYield.yieldVehicle(vehicle.name, session.mapRecordId);
      const issued = await this.pickupOrders.issue(
        context.task,
        context.cargo,
        session.mapRecordId,
        vehicle.name,
        distance,
        {
          matcher: this.matcher,
          batchSize: round.assignments.length,
          approachDistance: context.approachDistance,
          ...comparableCounterfactual(round.counterfactualByTask.get(taskId)),
        },
      );
      if (!issued) {
        session.quarantined.add(vehicle.name);
        this.logger.warn(
          `Vehicle ${vehicle.name} assignment failed — quarantined for this cycle`,
        );
        continue;
      }

      vehicle.hasActiveTask = true;
    }
  }

  private logCandidates(
    readyCount: number,
    candidates: readonly VehicleCandidate[],
  ): void {
    this.logger.debug(
      `Assignment: ${readyCount} READY task(s); candidates=[` +
        candidates
          .map(
            (c) =>
              `${c.name}{disp:${c.dispatchEnabled},ign:${c.ignored},avail:${c.available},busy:${c.hasActiveTask},e:${c.energyLevel}/${c.criticalThreshold},pos:${c.currentPosition ?? '?'}}`,
          )
          .join(' ') +
        ']',
    );
  }

  private async buildContext(
    task: TransportTaskEntity,
    distances: DispatchDistances,
  ): Promise<DispatchContext | null> {
    const cargo = task.cargoId
      ? await this.cargoRepo.findOne({ where: { id: task.cargoId } })
      : null;
    if (!cargo?.sourcePickupLocationName) {
      this.logger.warn(`Task ${task.id} missing pickup location — skipping`);
      return null;
    }
    return {
      task,
      cargo,
      distanceByPoint: cargo.sourcePointName
        ? distances.distancesTo(cargo.sourcePointName)
        : null,
      approachDistance: await distances.approachDistanceOf(cargo),
    };
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
      if (name) byVehicle.set(name, task);
    }
    return byVehicle;
  }
}

function toTaskCandidate(context: DispatchContext): DispatchTaskCandidate {
  return {
    taskId: context.task.id,
    distanceByPoint: context.distanceByPoint,
    approachDistance: context.approachDistance,
  };
}
