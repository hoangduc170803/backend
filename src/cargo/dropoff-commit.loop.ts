import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not, QueryRunner, Repository } from 'typeorm';
import { VehicleStateStore } from '../opentcs/vehicle-state.store';
import { ActiveMapContext } from '../maps/infrastructure/active-map-context.service';
import { ZoneEntity } from '../zones/entities/zone.entity';
import { CargoEntity, CargoStatus } from './entities/cargo.entity';
import {
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';
import { DeliverySlotEngine } from './delivery-slot.engine';
import {
  SlotReservationService,
  type SlotCommitResult,
} from './slot-reservation.service';
import { VehicleAimService, type AimedVehicle } from './vehicle-aim.service';
import {
  serveOrder,
  spotInReservedLane,
  standsOnASlot,
} from './domain/dropoff-lane';
import { targetOf } from './domain/column-queue';
import { queueOfLane } from './domain/dropoff-lane';
import { seatTheQueue } from './domain/queue-assignment';
import {
  laneOfLocation,
  type ZoneLane,
  type ZoneSlotLayout,
} from './domain/zone-slot-layout';
import {
  afterMoving,
  depthOfTarget,
  inversionIn,
  stuckForMs,
  LANE_LATCH_MS,
  MAX_SLOT_SWAPS,
  NO_PROGRESS_MS,
  type LaneStanding,
  type LaneWatermark,
} from './domain/lane-order';
import { KernelSessionService } from '../kernel-session/kernel-session.service';

const TICK_MS = 200;
const SINGLE_RUNNER_LOCK_KEY = 815_004_711;
const RUNNER_LOCK_RECHECK_MS = 10_000;
const FULL_PASS_EVERY_MS = 2_000;
const STUCK_SWEEP_EVERY_MS = 1_000;

interface CommitCandidate {
  readonly task: TransportTaskEntity;
  readonly vehicle: string;
  readonly cargo: CargoEntity;
  readonly zone: ZoneEntity;
  readonly layout: ZoneSlotLayout;
  readonly lane: ZoneLane;
  readonly depth: number;
}

interface WaitingVehicle {
  readonly task: TransportTaskEntity;
  readonly vehicle: string;
  readonly cargoId: string;
  readonly reserved: string | null;
}

interface VacatedCell {
  readonly aimed: AimedVehicle;
  readonly fallback: string | null;
}

interface Standing extends LaneStanding {
  readonly task: TransportTaskEntity;
  readonly vehicle: string;
}

interface LaneLineup {
  readonly key: string;
  readonly zone: ZoneEntity;
  readonly layout: ZoneSlotLayout;
  readonly lane: ZoneLane;
  readonly standings: Standing[];
}

interface ZoneWithLayout {
  readonly zone: ZoneEntity;
  readonly layout: ZoneSlotLayout;
}

@Injectable()
export class DropoffCommitLoop implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DropoffCommitLoop.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private runnerLock: RunnerLock | null = null;
  private lockVerifiedAt = 0;
  private lastFingerprint = '';
  private lastSweepAt = 0;
  private readonly watermarkByLane = new Map<string, LaneWatermark>();
  private readonly latchedUntilByLane = new Map<string, number>();

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    @InjectRepository(ZoneEntity)
    private readonly zoneRepo: Repository<ZoneEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly vehicleStore: VehicleStateStore,
    private readonly deliverySlotEngine: DeliverySlotEngine,
    private readonly slotReservation: SlotReservationService,
    private readonly vehicleAim: VehicleAimService,
    private readonly activeMap: ActiveMapContext,
    private readonly kernelSession: KernelSessionService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.releaseRunnerLock();
  }

  async tick(): Promise<void> {
    if (this.ticking || !this.kernelSession.isReady()) return;
    this.ticking = true;
    try {
      if (!(await this.holdsRunnerLock())) return;
      const mapRecordId = await this.activeMap.id();
      if (!mapRecordId) return;

      const tasks = await this.tasksAwaitingCommit(mapRecordId);
      await this.issueDeferredDropoffs(tasks);
      const taskByCargoId = new Map(
        tasks
          .filter((task) => task.cargoId)
          .map((task) => [task.cargoId!, task] as const),
      );

      const fingerprint = this.fingerprintOf(tasks);
      if (fingerprint !== this.lastFingerprint) {
        this.lastFingerprint = fingerprint;
        const candidates = await this.commitCandidates(tasks);
        for (const candidate of serveOrder(candidates)) {
          await this.commitOne(candidate, taskByCargoId);
        }
      }

      await this.sweepStuckLanes(tasks);
    } catch (err) {
      this.logger.error(
        `Drop-off commit tick failed: ${(err as Error).message}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  private async tasksAwaitingCommit(
    mapRecordId: string,
  ): Promise<TransportTaskEntity[]> {
    return this.taskRepo.find({
      where: {
        status: TaskStatus.DELIVERING,
        cargoId: Not(IsNull()),
        mapRecordId,
      },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  private async issueDeferredDropoffs(
    tasks: readonly TransportTaskEntity[],
  ): Promise<void> {
    for (const task of tasks) {
      const pending = task.metadata?.pendingDropoff;
      if (!pending) continue;
      const zone = await this.zoneRepo.findOne({
        where: { id: pending.zoneId },
        relations: { members: true },
      });
      if (!zone) continue;
      await this.vehicleAim.issueDeferredDropoff(task, zone);
    }
  }

  private fingerprintOf(tasks: readonly TransportTaskEntity[]): string {
    const marks = tasks.map((task) => {
      const vehicle = task.metadata?.assignedVehicleName ?? '';
      const position = vehicle
        ? (this.vehicleStore.get(vehicle)?.currentPosition ?? '')
        : '';
      return [
        task.id,
        task.status,
        vehicle,
        position,
        task.metadata?.unloadedAt ?? '',
      ].join(':');
    });
    return [Math.floor(Date.now() / FULL_PASS_EVERY_MS), ...marks].join('|');
  }

  private async sweepStuckLanes(
    tasks: readonly TransportTaskEntity[],
  ): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweepAt < STUCK_SWEEP_EVERY_MS) return;
    this.lastSweepAt = now;

    const lineups = await this.laneLineups(tasks);
    this.forgetLanesOutOfPlay(lineups);

    for (const lineup of lineups) {
      const mark = afterMoving(
        this.watermarkByLane.get(lineup.key),
        lineup.standings,
        now,
      );
      this.watermarkByLane.set(lineup.key, mark);

      if ((this.latchedUntilByLane.get(lineup.key) ?? 0) > now) continue;
      if (stuckForMs(mark, now) < NO_PROGRESS_MS) continue;
      if (!(await this.repairLane(lineup))) continue;

      this.latchedUntilByLane.set(lineup.key, now + LANE_LATCH_MS);
      this.watermarkByLane.delete(lineup.key);
    }
  }

  private forgetLanesOutOfPlay(lineups: readonly LaneLineup[]): void {
    const inPlay = new Set(lineups.map((lineup) => lineup.key));
    for (const key of [...this.watermarkByLane.keys()]) {
      if (!inPlay.has(key)) this.watermarkByLane.delete(key);
    }
    for (const key of [...this.latchedUntilByLane.keys()]) {
      if (!inPlay.has(key)) this.latchedUntilByLane.delete(key);
    }
  }

  private async laneLineups(
    tasks: readonly TransportTaskEntity[],
  ): Promise<LaneLineup[]> {
    const lineups = new Map<string, LaneLineup>();
    const zones = new Map<string, ZoneWithLayout | null>();

    for (const task of tasks) {
      const standing = await this.standingOf(task, zones);
      if (!standing) continue;

      const lineup = lineups.get(standing.key) ?? {
        key: standing.key,
        zone: standing.zone,
        layout: standing.layout,
        lane: standing.lane,
        standings: [],
      };
      lineup.standings.push(standing.standing);
      lineups.set(standing.key, lineup);
    }
    return [...lineups.values()];
  }

  private async standingOf(
    task: TransportTaskEntity,
    zones: Map<string, ZoneWithLayout | null>,
  ): Promise<{
    key: string;
    zone: ZoneEntity;
    layout: ZoneSlotLayout;
    lane: ZoneLane;
    standing: Standing;
  } | null> {
    const vehicle = task.metadata?.assignedVehicleName;
    const position = vehicle
      ? this.vehicleStore.get(vehicle)?.currentPosition
      : null;
    if (!vehicle || !position || !task.cargoId) return null;

    const cargo = await this.cargoRepo.findOne({
      where: { id: task.cargoId, status: In([CargoStatus.ACTIVE]) },
    });
    if (!cargo?.destinationZoneId) return null;

    const target = cargo.destinationLocationName ?? cargo.reservedLocationName;
    if (!target) return null;

    const known = await this.zoneWithLayout(zones, cargo.destinationZoneId);
    if (!known) return null;

    const laneIndex = known.layout.lanes.findIndex((lane) =>
      lane.axisPoints.includes(position),
    );
    if (laneIndex === -1) return null;

    const lane = known.layout.lanes[laneIndex];
    const targetDepth = depthOfTarget(lane, target);
    if (targetDepth === -1) return null;

    return {
      key: `${cargo.destinationZoneId}#${laneIndex}`,
      zone: known.zone,
      layout: known.layout,
      lane,
      standing: {
        task,
        vehicle,
        cargoId: cargo.id,
        posDepth: lane.axisPoints.indexOf(position),
        targetDepth,
        committed: cargo.destinationLocationName !== null,
        unloaded: task.metadata?.unloadedAt != null,
        swapCount: task.metadata?.swapCount ?? 0,
      },
    };
  }

  private async zoneWithLayout(
    zones: Map<string, ZoneWithLayout | null>,
    zoneId: string,
  ): Promise<ZoneWithLayout | null> {
    if (zones.has(zoneId)) return zones.get(zoneId) ?? null;

    const zone = await this.zoneRepo.findOne({
      where: { id: zoneId },
      relations: { members: true },
    });
    const layout = zone ? await this.deliverySlotEngine.layoutFor(zone) : null;
    const known = zone && layout ? { zone, layout } : null;
    zones.set(zoneId, known);
    return known;
  }

  private async repairLane(lineup: LaneLineup): Promise<boolean> {
    const inversion = inversionIn(lineup.standings);
    if (!inversion) return false;

    const { ahead, holder } = inversion;
    if (holder.swapCount >= MAX_SLOT_SWAPS) {
      this.logger.error(
        `Task ${holder.task.id}: ${holder.vehicle} already gave up its slot ${holder.swapCount} times — leaving lane ${lineup.lane.axis} of "${lineup.zone.name}" stuck behind ${ahead.vehicle}`,
      );
      return false;
    }

    this.logger.warn(
      `Lane ${lineup.lane.axis} of "${lineup.zone.name}" made no progress for ${NO_PROGRESS_MS}ms: ${ahead.vehicle} stands deeper than ${holder.vehicle} yet ${holder.vehicle} holds the deeper slot — taking that slot back`,
    );

    const aimed: AimedVehicle = {
      task: holder.task,
      vehicle: holder.vehicle,
      cargoId: holder.cargoId,
    };
    await this.slotReservation.releaseCommit(holder.cargoId, lineup.zone);
    await this.vehicleAim.stopDropping(aimed);
    await this.countSwap(holder.task);

    const queued = await this.slotReservation.reserve(
      holder.cargoId,
      lineup.zone,
      holder.vehicle,
    );
    if (!queued) {
      this.logger.error(
        `Task ${holder.task.id}: ${holder.vehicle} gave up its slot but zone "${lineup.zone.name}" had nowhere to queue it`,
      );
      return true;
    }

    await this.vehicleAim.queueAt(aimed, lineup.zone, lineup.layout, queued);
    return true;
  }

  private async countSwap(task: TransportTaskEntity): Promise<void> {
    task.metadata = {
      ...task.metadata,
      swapCount: (task.metadata?.swapCount ?? 0) + 1,
    };
    await this.taskRepo.save(task);
  }

  private async commitCandidates(
    tasks: readonly TransportTaskEntity[],
  ): Promise<CommitCandidate[]> {
    const candidates: CommitCandidate[] = [];
    for (const task of tasks) {
      const candidate = await this.candidateFor(task);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }

  private async candidateFor(
    task: TransportTaskEntity,
  ): Promise<CommitCandidate | null> {
    const vehicle = task.metadata?.assignedVehicleName;
    const position = vehicle
      ? this.vehicleStore.get(vehicle)?.currentPosition
      : null;
    if (!vehicle || !position) return null;

    const cargo = await this.cargoRepo.findOne({
      where: { id: task.cargoId!, status: In([CargoStatus.ACTIVE]) },
    });
    if (
      !cargo ||
      cargo.destinationLocationName ||
      !cargo.destinationZoneId ||
      !cargo.reservedLocationName
    ) {
      return null;
    }
    const reservedTarget = cargo.reservedLocationName;

    const zone = await this.zoneRepo.findOne({
      where: { id: cargo.destinationZoneId },
      relations: { members: true },
    });
    if (!zone) return null;

    const layout = await this.deliverySlotEngine.layoutFor(zone);
    if (!layout) return null;

    const spot = spotInReservedLane(layout, reservedTarget, position);
    if (!spot) return null;

    return {
      task,
      vehicle,
      cargo,
      zone,
      layout,
      lane: spot.lane,
      depth: spot.depth,
    };
  }

  // TODO: nothing releases a lane when the drop-off never completes. A cargo
  // that is committed but never reaches unloadedAt — drop-off order FAILED or
  // UNROUTABLE, order withdrawn, vehicle fault or lost navigation — blocks its
  // lane forever, and every vehicle reserved into that lane waits behind it.
  // Needs both a timeout on the committed-but-not-unloaded state and a release
  // on terminal order state, which then has to hand the slot back to ranking.
  private async slotsOfBusyLanes(
    candidate: CommitCandidate,
    taskByCargoId: ReadonlyMap<string, TransportTaskEntity>,
  ): Promise<Set<string>> {
    const inFlight = await this.cargoRepo.find({
      where: {
        destinationZoneId: candidate.zone.id,
        status: CargoStatus.ACTIVE,
        destinationLocationName: Not(IsNull()),
      },
    });

    const blocked = new Set<string>();
    for (const cargo of inFlight) {
      const lane = laneOfLocation(
        candidate.layout,
        cargo.destinationLocationName!,
      );
      if (!lane) continue;
      if (this.hasLeftLane(cargo, lane, taskByCargoId)) continue;
      for (const slot of lane.slots) blocked.add(slot.locationName);
    }
    return blocked;
  }

  private hasLeftLane(
    cargo: CargoEntity,
    lane: ZoneLane,
    taskByCargoId: ReadonlyMap<string, TransportTaskEntity>,
  ): boolean {
    const task = taskByCargoId.get(cargo.id);
    if (!task?.metadata?.unloadedAt) return false;

    const vehicle = task.metadata.assignedVehicleName;
    const position = vehicle
      ? this.vehicleStore.get(vehicle)?.currentPosition
      : null;
    if (!position) return false;

    return !standsOnASlot(lane, position);
  }

  private async commitOne(
    candidate: CommitCandidate,
    taskByCargoId: ReadonlyMap<string, TransportTaskEntity>,
  ): Promise<void> {
    try {
      await this.commitCandidate(candidate, taskByCargoId);
    } catch (err) {
      this.logger.error(
        `Task ${candidate.task.id}: ${candidate.vehicle} failed mid-commit in lane ${candidate.lane.axis}: ${(err as Error).message}`,
      );
    }
  }

  private async commitCandidate(
    candidate: CommitCandidate,
    taskByCargoId: ReadonlyMap<string, TransportTaskEntity>,
  ): Promise<void> {
    const result = await this.slotReservation.commit(
      candidate.cargo.id,
      candidate.zone,
      {
        lane: candidate.lane,
        blockedLocationNames: await this.slotsOfBusyLanes(
          candidate,
          taskByCargoId,
        ),
        unstealableLocationNames: await this.reservationsHeldAhead(
          candidate,
          taskByCargoId,
        ),
        requesterVehicleName: candidate.vehicle,
      },
    );
    if (!result) return;

    await this.applyCommit(candidate, result, taskByCargoId);
  }

  private async reservationsHeldAhead(
    candidate: CommitCandidate,
    taskByCargoId: ReadonlyMap<string, TransportTaskEntity>,
  ): Promise<Set<string>> {
    const queued = await this.cargoRepo.find({
      where: {
        destinationZoneId: candidate.zone.id,
        status: CargoStatus.ACTIVE,
        destinationLocationName: IsNull(),
      },
    });

    const held = new Set<string>();
    for (const cargo of queued) {
      if (cargo.id === candidate.cargo.id) continue;
      if (!cargo.reservedLocationName) continue;

      const vehicle = taskByCargoId.get(cargo.id)?.metadata
        ?.assignedVehicleName;
      const position = vehicle
        ? this.vehicleStore.get(vehicle)?.currentPosition
        : null;
      const depth = position ? candidate.lane.axisPoints.indexOf(position) : -1;
      if (depth !== -1 && depth < candidate.depth) {
        held.add(cargo.reservedLocationName);
      }
    }
    return held;
  }

  private async applyCommit(
    candidate: CommitCandidate,
    result: SlotCommitResult,
    taskByCargoId: ReadonlyMap<string, TransportTaskEntity>,
  ): Promise<void> {
    const { task, vehicle } = candidate;
    const vacated = await this.clearTheWayTo(result, taskByCargoId);

    const dropping = await this.vehicleAim.dropAt(
      { task, vehicle, cargoId: candidate.cargo.id },
      candidate.zone,
      result.slot,
      result.keptOwnReservation,
    );
    if (!dropping) {
      await this.putBackOnItsOrder(candidate, vacated);
      return;
    }

    this.logger.log(`Task ${task.id}: ${vehicle} committed ${result.slot}`);

    if (result.displaced) {
      await this.recordDisplaced(result, vehicle, taskByCargoId);
    }
    await this.reaimLane(candidate, result.slot, taskByCargoId);
  }

  private async clearTheWayTo(
    result: SlotCommitResult,
    taskByCargoId: ReadonlyMap<string, TransportTaskEntity>,
  ): Promise<VacatedCell | null> {
    const displaced = result.displaced;
    if (!displaced) return null;

    const task = await this.displacedTask(displaced.cargoId, taskByCargoId);
    const vehicle = task?.metadata?.assignedVehicleName;
    if (!task || !vehicle) return null;
    if (task.metadata?.approachPointName !== result.slot) return null;

    const aimed: AimedVehicle = {
      task,
      vehicle,
      cargoId: displaced.cargoId,
    };
    await this.vehicleAim.stopApproaching(aimed);
    this.logger.log(
      `Task ${task.id}: ${vehicle} let go of ${result.slot} before it was handed over`,
    );
    return { aimed, fallback: displaced.replacementSlot };
  }

  private async putBackOnItsOrder(
    candidate: CommitCandidate,
    vacated: VacatedCell | null,
  ): Promise<void> {
    if (!vacated?.fallback) return;

    await this.vehicleAim.queueAt(
      vacated.aimed,
      candidate.zone,
      candidate.layout,
      vacated.fallback,
    );
  }

  private async displacedTask(
    cargoId: string,
    taskByCargoId: ReadonlyMap<string, TransportTaskEntity>,
  ): Promise<TransportTaskEntity | null> {
    return (
      taskByCargoId.get(cargoId) ??
      (await this.taskRepo.findOne({
        where: { cargoId, status: TaskStatus.DELIVERING },
      }))
    );
  }

  private async reaimLane(
    candidate: CommitCandidate,
    committedSlot: string,
    taskByCargoId: ReadonlyMap<string, TransportTaskEntity>,
  ): Promise<void> {
    const lane = laneOfLocation(candidate.layout, committedSlot);
    if (!lane) return;

    const laneIndex = candidate.layout.lanes.indexOf(lane);
    if (laneIndex === -1) return;

    const chain = queueOfLane(candidate.layout, laneIndex, {
      finished: await this.palletsAlreadyDown(candidate.zone.id),
      committed: new Set([committedSlot]),
      reserved: new Set<string>(),
    })
      .standing()
      .slice(1)
      .map(targetOf);
    const waiting = await this.waitingBehind(candidate, lane, taskByCargoId);
    const heldElsewhere = await this.cellsHeldOutside(candidate, waiting);

    for (const { entry, target } of seatTheQueue(
      chain,
      waiting,
      heldElsewhere,
    )) {
      if (!target) {
        this.logger.warn(
          `Task ${entry.task.id}: ${entry.vehicle} has nowhere left to wait behind ${committedSlot}`,
        );
        continue;
      }
      if (entry.reserved === target && entry.task.metadata?.approachOrderName)
        continue;
      await this.vehicleAim.queueAt(
        entry,
        candidate.zone,
        candidate.layout,
        target,
      );
    }
  }

  private async palletsAlreadyDown(zoneId: string): Promise<Set<string>> {
    const delivered = await this.cargoRepo.find({
      where: { destinationZoneId: zoneId, status: CargoStatus.DELIVERED },
    });
    return delivered.reduce((names, cargo) => {
      if (cargo.destinationLocationName !== null)
        names.add(cargo.destinationLocationName);
      return names;
    }, new Set<string>());
  }

  private async waitingBehind(
    candidate: CommitCandidate,
    lane: ZoneLane,
    taskByCargoId: ReadonlyMap<string, TransportTaskEntity>,
  ): Promise<WaitingVehicle[]> {
    const laneTargets = new Set<string>([
      ...lane.slots.map((slot) => slot.locationName),
      ...lane.axisPoints,
    ]);
    const cargos = await this.cargoRepo.find({
      where: {
        destinationZoneId: candidate.zone.id,
        status: CargoStatus.ACTIVE,
        destinationLocationName: IsNull(),
      },
    });

    const waiting: (WaitingVehicle & { distance: number })[] = [];
    for (const cargo of cargos) {
      if (cargo.id === candidate.cargo.id) continue;
      if (
        !cargo.reservedLocationName ||
        !laneTargets.has(cargo.reservedLocationName)
      ) {
        continue;
      }
      const task = taskByCargoId.get(cargo.id);
      const vehicle = task?.metadata?.assignedVehicleName;
      if (!task || !vehicle) continue;

      const position = this.vehicleStore.get(vehicle)?.currentPosition;
      const onAxis = position ? lane.axisPoints.indexOf(position) : -1;
      waiting.push({
        task,
        vehicle,
        cargoId: cargo.id,
        reserved: cargo.reservedLocationName,
        distance: onAxis === -1 ? Number.MAX_SAFE_INTEGER : onAxis,
      });
    }

    return waiting
      .sort((a, b) => a.distance - b.distance)
      .map(({ task, vehicle, cargoId, reserved }) => ({
        task,
        vehicle,
        cargoId,
        reserved,
      }));
  }

  private async cellsHeldOutside(
    candidate: CommitCandidate,
    waiting: readonly WaitingVehicle[],
  ): Promise<Set<string>> {
    const theirs = new Set(waiting.map((entry) => entry.cargoId));
    const cargos = await this.cargoRepo.find({
      where: {
        status: CargoStatus.ACTIVE,
        destinationLocationName: IsNull(),
      },
    });

    return cargos.reduce((held, cargo) => {
      const isSomeoneElse =
        !theirs.has(cargo.id) && cargo.id !== candidate.cargo.id;
      if (isSomeoneElse && cargo.reservedLocationName) {
        held.add(cargo.reservedLocationName);
      }
      return held;
    }, new Set<string>());
  }

  private async recordDisplaced(
    result: SlotCommitResult,
    winner: string,
    taskByCargoId: ReadonlyMap<string, TransportTaskEntity>,
  ): Promise<void> {
    const displaced = result.displaced!;
    const victim = await this.displacedTask(displaced.cargoId, taskByCargoId);
    if (!victim) return;

    const victimVehicle = victim.metadata?.assignedVehicleName;
    if (!victimVehicle) return;

    if (!displaced.replacementSlot) {
      this.logger.error(
        `Task ${victim.id}: ${victimVehicle} lost ${displaced.lostSlot} to ${winner} and no slot is left`,
      );
      return;
    }

    victim.metadata = {
      ...victim.metadata,
      swapCount: (victim.metadata?.swapCount ?? 0) + 1,
    };
    await this.taskRepo.save(victim);
    this.logger.log(
      `Task ${victim.id}: ${victimVehicle} lost ${displaced.lostSlot} to ${winner}, now reserved ${displaced.replacementSlot} (still waiting at the gate)`,
    );
  }

  private async holdsRunnerLock(): Promise<boolean> {
    if (this.runnerLock && !(await this.lockStillAlive())) {
      this.logger.warn(
        'Lost the drop-off commit lock, taking it again if it is free',
      );
      await this.releaseRunnerLock();
    }
    if (this.runnerLock) return true;

    this.runnerLock = await this.acquireSingleRunnerLock();
    if (this.runnerLock) {
      this.lockVerifiedAt = Date.now();
      this.logger.log('Now running the drop-off commit loop');
    }
    return this.runnerLock !== null;
  }

  private async lockStillAlive(): Promise<boolean> {
    const lock = this.runnerLock;
    if (!lock) return false;
    if (Date.now() - this.lockVerifiedAt < RUNNER_LOCK_RECHECK_MS) return true;

    const alive = await lock.ping();
    if (alive) this.lockVerifiedAt = Date.now();
    return alive;
  }

  private async releaseRunnerLock(): Promise<void> {
    const lock = this.runnerLock;
    this.runnerLock = null;
    this.lockVerifiedAt = 0;
    if (!lock) return;
    try {
      await lock.release();
    } catch (err) {
      this.logger.warn(
        `Could not release the drop-off commit lock: ${(err as Error).message}`,
      );
    }
  }

  private async acquireSingleRunnerLock(): Promise<RunnerLock | null> {
    const runner = this.dataSource.createQueryRunner();
    try {
      await runner.connect();
      const [{ locked }] = (await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [SINGLE_RUNNER_LOCK_KEY],
      )) as { locked: boolean }[];
      if (locked) return runnerLockOn(runner);
    } catch (err) {
      this.logger.warn(
        `Could not reach the database for the drop-off commit lock: ${(err as Error).message}`,
      );
    }
    await runner.release().catch(() => undefined);
    return null;
  }
}

interface RunnerLock {
  ping: () => Promise<boolean>;
  release: () => Promise<void>;
}

function runnerLockOn(runner: QueryRunner): RunnerLock {
  return {
    ping: async () => {
      try {
        await runner.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    release: async () => {
      try {
        await runner.query('SELECT pg_advisory_unlock($1)', [
          SINGLE_RUNNER_LOCK_KEY,
        ]);
      } finally {
        await runner.release();
      }
    },
  };
}
