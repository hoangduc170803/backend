import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { OperatingAreasService } from '../application/operating-areas.service';
import { OperatingCargoService } from '../application/operating-cargo.service';
import { OperatingPlantModelService } from '../application/operating-plant-model.service';
import type { AreaDto, CargoDto } from '../dto/operating.dto';
import {
  MIN_GENERATOR_INTERVAL_SECONDS,
  type CargoGeneratorConfigDto,
  type CargoGeneratorLogEntry,
  type CargoGeneratorOperator,
  type CargoGeneratorStateDto,
  type GeneratorLogLevel,
  type GeneratorPhase,
} from './cargo-generator.dto';
import { storeRoom } from './domain/occupancy';
import {
  INITIAL_CURSOR,
  pickNext,
  type PickCursor,
} from './domain/pick-strategy';
import {
  freePointsAcross,
  pickStore,
  poolZones,
  storesWithRoom,
} from './domain/selection';

const LOG_LIMIT = 60;
const MAX_CONSECUTIVE_ERRORS = 3;
const STORE_FULL_PATTERN = /đầy|full/i;
const ALREADY_RUNNING =
  'Bộ tạo hàng đang chạy — chỉ một phiên được chạy tại một thời điểm.';

export interface GeneratorOperator extends CargoGeneratorOperator {
  mapIds?: string[];
  canDeleteCargo: boolean;
}

interface Session {
  abort: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  roundRunning: boolean;
  config: CargoGeneratorConfigDto;
  operator: GeneratorOperator;
}

interface FloorState {
  areas: AreaDto[];
  cargos: CargoDto[];
}

export function cancellableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (milliseconds <= 0 || signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

@Injectable()
export class CargoGeneratorService implements OnModuleDestroy {
  private readonly logger = new Logger(CargoGeneratorService.name);
  private session: Session | null = null;
  private phase: GeneratorPhase = 'idle';
  private lastConfig: CargoGeneratorConfigDto | null = null;
  private startedBy: CargoGeneratorOperator | null = null;
  private startedAt: Date | null = null;
  private nextRoundAt: Date | null = null;
  private createdTotal = 0;
  private createdThisRound = 0;
  private rounds = 0;
  private entries: CargoGeneratorLogEntry[] = [];
  private entrySequence = 0;

  constructor(
    private readonly areas: OperatingAreasService,
    private readonly cargo: OperatingCargoService,
    private readonly plantModel: OperatingPlantModelService,
  ) {}

  onModuleDestroy(): void {
    this.endSession();
  }

  state(): CargoGeneratorStateDto {
    return {
      phase: this.phase,
      config: this.lastConfig,
      startedBy: this.startedBy,
      startedAt: this.startedAt?.toISOString() ?? null,
      createdTotal: this.createdTotal,
      createdThisRound: this.createdThisRound,
      rounds: this.rounds,
      nextRoundAt: this.nextRoundAt?.toISOString() ?? null,
      log: this.entries,
    };
  }

  start(
    config: CargoGeneratorConfigDto,
    operator: GeneratorOperator,
  ): CargoGeneratorStateDto {
    if (this.session) throw new ConflictException(ALREADY_RUNNING);
    const session: Session = {
      abort: new AbortController(),
      timer: null,
      roundRunning: false,
      config,
      operator,
    };
    this.session = session;
    this.lastConfig = config;
    this.startedBy = { userId: operator.userId, username: operator.username };
    this.startedAt = new Date();
    this.log('info', 'started', { user: operator.username });
    this.logger.log(`Cargo generator started by ${operator.username}`);
    void this.tick(session);
    return this.state();
  }

  stop(username: string): CargoGeneratorStateDto {
    if (!this.session) return this.state();
    this.endSession();
    this.log('info', 'stoppedBy', { user: username });
    this.logger.log(`Cargo generator stopped by ${username}`);
    return this.state();
  }

  runNow(): CargoGeneratorStateDto {
    const session = this.session;
    if (!session || session.roundRunning) return this.state();
    if (session.timer) clearTimeout(session.timer);
    void this.tick(session);
    return this.state();
  }

  resetStatistics(): CargoGeneratorStateDto {
    if (this.session) throw new ConflictException(ALREADY_RUNNING);
    this.createdTotal = 0;
    this.createdThisRound = 0;
    this.rounds = 0;
    this.entries = [];
    return this.state();
  }

  private endSession(): void {
    const session = this.session;
    if (!session) return;
    session.abort.abort();
    if (session.timer) clearTimeout(session.timer);
    this.session = null;
    this.phase = 'idle';
    this.nextRoundAt = null;
  }

  private log(
    level: GeneratorLogLevel,
    key: string,
    vars: Record<string, string | number> = {},
  ): void {
    this.entrySequence += 1;
    this.entries = [
      {
        id: this.entrySequence,
        at: new Date().toISOString(),
        level,
        key,
        vars,
      },
      ...this.entries,
    ].slice(0, LOG_LIMIT);
  }

  private async tick(session: Session): Promise<void> {
    session.timer = null;
    if (session.abort.signal.aborted || session.roundRunning) return;
    session.roundRunning = true;
    try {
      await this.runRound(session);
    } finally {
      session.roundRunning = false;
      if (!session.abort.signal.aborted) {
        this.log('info', 'roundEnd', { n: this.createdThisRound });
        this.scheduleNext(session);
      }
    }
  }

  private scheduleNext(session: Session): void {
    const delayMs =
      Math.max(MIN_GENERATOR_INTERVAL_SECONDS, session.config.intervalSec) *
      1000;
    this.phase = 'waiting';
    this.nextRoundAt = new Date(Date.now() + delayMs);
    session.timer = setTimeout(() => void this.tick(session), delayMs);
  }

  private async floorState(session: Session): Promise<FloorState> {
    const [areas, cargoList] = await Promise.all([
      this.areas.list(session.operator.mapIds),
      this.cargo.list({}, session.operator.mapIds),
    ]);
    return { areas, cargos: cargoList.cargos };
  }

  private selectedAreas(areas: AreaDto[], config: CargoGeneratorConfigDto) {
    const zoneIds = new Set(config.zoneIds);
    const storeIds = new Set(config.storeIds);
    return {
      zones: areas.filter(
        (area) => area.kind === 'ZONE' && zoneIds.has(area.wesId),
      ),
      stores: areas.filter(
        (area) => area.kind === 'STORE' && storeIds.has(area.wesId),
      ),
    };
  }

  private async makeRoomInStores(session: Session): Promise<boolean> {
    const { areas, cargos } = await this.floorState(session);
    const { stores } = this.selectedAreas(areas, session.config);
    let cleared = false;
    let anyRoom = false;
    for (const target of stores) {
      const { room, deliveredFull, finishedCargoIds } = storeRoom(
        target,
        cargos,
      );
      if (room > 0) {
        anyRoom = true;
        continue;
      }
      if (!deliveredFull) continue;
      if (!session.operator.canDeleteCargo) {
        this.log('warn', 'storeFullNoPermission', { store: target.name });
        continue;
      }
      const { results } = await this.cargo.cancelMany(
        finishedCargoIds,
        session.operator.mapIds,
      );
      const deleted = results.filter(
        (result) => result.outcome === 'deleted',
      ).length;
      this.log(deleted < results.length ? 'warn' : 'info', 'clearedFinished', {
        n: deleted,
        total: finishedCargoIds.length,
        store: target.name,
      });
      if (deleted > 0) cleared = true;
    }
    if (!cleared) return anyRoom;

    const fresh = await this.floorState(session);
    return this.selectedAreas(fresh.areas, session.config).stores.some(
      (target) => storeRoom(target, fresh.cargos).room > 0,
    );
  }

  private async runRound(session: Session): Promise<void> {
    const signal = session.abort.signal;
    const config = session.config;
    this.phase = 'running';
    this.nextRoundAt = null;
    this.rounds += 1;
    this.createdThisRound = 0;
    this.log('info', 'roundStart');

    try {
      const initialState = await this.floorState(session);
      const initial = this.selectedAreas(initialState.areas, config);
      if (initial.zones.length === 0 || initial.stores.length === 0) {
        this.log('error', 'areaMissing');
        return;
      }
      if (freePointsAcross(initial.zones, initialState.cargos).size === 0) {
        this.log('info', 'zoneFull');
        return;
      }
      if (!(await this.makeRoomInStores(session))) {
        this.log('info', 'storeFull');
        return;
      }

      const [{ points }, paths] = await Promise.all([
        this.plantModel.points(),
        this.plantModel.paths(),
      ]);
      const { lanes, zoneOfPoint } = poolZones(initial.zones, points, paths);
      const skipped = new Set<string>();
      const reportedFull = new Set<string>();
      let cursor: PickCursor = INITIAL_CURSOR;
      let errors = 0;

      while (!signal.aborted) {
        const { areas, cargos } = await this.floorState(session);
        const { zones, stores } = this.selectedAreas(areas, config);
        const target = pickStore(storesWithRoom(stores, cargos, reportedFull));
        if (!target) {
          this.log('info', 'storeFull');
          return;
        }
        const free = freePointsAcross(zones, cargos);
        for (const name of skipped) free.delete(name);
        const next = pickNext(
          config.mode,
          lanes,
          free,
          cursor,
          config.batchSize,
        );
        const zone = next ? zoneOfPoint.get(next.point) : undefined;
        if (!next || !zone) {
          this.log('info', 'zoneFull');
          return;
        }
        cursor = next.cursor;

        try {
          const created = await this.cargo.create(
            {
              pickupAreaWesId: zone.wesId,
              pickupPointName: next.point,
              targetStoreAreaWesId: target.wesId,
            },
            session.operator.userId,
            session.operator.mapIds,
          );
          errors = 0;
          this.createdTotal += 1;
          this.createdThisRound += 1;
          this.log('info', 'created', {
            id: created.itemCode,
            point: next.point,
            store: target.name,
          });
        } catch (error) {
          const reason = messageOf(error);
          if (STORE_FULL_PATTERN.test(reason)) {
            reportedFull.add(target.wesId);
            this.log('info', 'oneStoreFull', { store: target.name });
            continue;
          }
          skipped.add(next.point);
          this.log('warn', 'createFailed', { point: next.point, reason });
          errors += 1;
          if (errors >= MAX_CONSECUTIVE_ERRORS) {
            this.log('error', 'tooManyErrors');
            return;
          }
          continue;
        }
        await cancellableSleep(config.delaySec * 1000, signal);
      }
    } catch (error) {
      if (!signal.aborted) {
        this.log('error', 'roundFailed', { reason: messageOf(error) });
      }
    }
  }
}
