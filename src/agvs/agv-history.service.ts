import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  In,
  IsNull,
  Repository,
  SelectQueryBuilder,
  type FindOptionsWhere,
} from 'typeorm';
import { AgvEntity } from './entities/agv.entity';
import {
  VehicleErrorEventEntity,
  VehicleErrorEventKind,
} from './entities/vehicle-error-event.entity';
import { VehicleStateTransitionEntity } from '../opentcs/entities/vehicle-state-transition.entity';
import { CargoEntity } from '../cargo/entities/cargo.entity';
import { TaskOrderEntity } from '../cargo/entities/task-order.entity';
import {
  TaskStatus,
  TransportTaskEntity,
} from '../cargo/entities/transport-task.entity';
import { toAgvErrorEventDto, toAgvStateChangeDto } from './agvs.mapper';
import {
  AgvErrorFrequencyEntry,
  AgvErrorFrequencyQueryDto,
  AgvErrorFrequencyResponse,
  AgvErrorHistoryResponse,
  AgvErrorWindow,
  AgvHistoryQueryDto,
  AgvStateLogResponse,
  AgvTaskHistoryEntryDto,
  AgvTaskHistoryQueryDto,
  AgvTaskHistoryResponse,
  DEFAULT_AGV_ERROR_WINDOW,
} from './dto/agvs.dto';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const DEFAULT_ERROR_FREQUENCY_LIMIT = 20;

const ASSIGNED_VEHICLE_EXPRESSION = `task.metadata ->> 'assignedVehicleName'`;

const WINDOW_HOURS: Record<AgvErrorWindow, number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

const FAULT_KINDS: VehicleErrorEventKind[] = ['RAISED', 'CHANGED'];

interface ErrorFrequencyRow {
  vehicle_name: string;
  map_record_id: string | null;
  error_count: number;
  last_occurred_at: Date;
}

interface TaskHistoryRow {
  task_id: string;
  request_code: string;
  status: TaskStatus;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  source_point_name: string | null;
  destination_location_name: string | null;
}

function resolvePaging(query: AgvHistoryQueryDto) {
  const page = query.page ?? DEFAULT_PAGE;
  const limit = query.limit ?? DEFAULT_LIMIT;
  return { page, limit, skip: (page - 1) * limit };
}

function windowStart(to: Date, window: AgvErrorWindow): Date {
  return new Date(to.getTime() - WINDOW_HOURS[window] * 60 * 60 * 1000);
}

function toTaskHistoryEntry(
  row: TaskHistoryRow,
  orders: readonly TaskOrderEntity[],
): AgvTaskHistoryEntryDto {
  return {
    taskId: row.request_code,
    source: row.source_point_name,
    destination: row.destination_location_name,
    startedAt: row.started_at,
    endedAt: row.completed_at ?? row.cancelled_at,
    status: row.status,
    orders: orders.map((order) => ({
      orderName: order.orderName,
      leg: order.leg,
      state: order.state,
    })),
  };
}

@Injectable()
export class AgvHistoryService {
  constructor(
    @InjectRepository(AgvEntity)
    private readonly agvRepo: Repository<AgvEntity>,
    @InjectRepository(VehicleStateTransitionEntity)
    private readonly transitionRepo: Repository<VehicleStateTransitionEntity>,
    @InjectRepository(VehicleErrorEventEntity)
    private readonly errorRepo: Repository<VehicleErrorEventEntity>,
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(TaskOrderEntity)
    private readonly orderRepo: Repository<TaskOrderEntity>,
  ) {}

  async taskHistory(
    id: string,
    query: AgvTaskHistoryQueryDto = {},
  ): Promise<AgvTaskHistoryResponse> {
    const agv = await this.requireAgv(id);
    const { page, limit, skip } = resolvePaging(query);

    const total = await this.taskHistoryFilter(agv, query).getCount();
    const rows = await this.taskHistoryFilter(agv, query)
      .withDeleted()
      .leftJoin(CargoEntity, 'cargo', 'cargo.id = task.cargoId')
      .select('task.id', 'task_id')
      .addSelect('task.requestCode', 'request_code')
      .addSelect('task.status', 'status')
      .addSelect('task.startedAt', 'started_at')
      .addSelect('task.completedAt', 'completed_at')
      .addSelect('task.cancelledAt', 'cancelled_at')
      .addSelect('cargo.sourcePointName', 'source_point_name')
      .addSelect('cargo.destinationLocationName', 'destination_location_name')
      .orderBy('task.createdAt', 'DESC')
      .addOrderBy('task.id', 'DESC')
      .offset(skip)
      .limit(limit)
      .getRawMany<TaskHistoryRow>();

    const orders = rows.length
      ? await this.orderRepo.find({
          where: { taskId: In(rows.map((row) => row.task_id)) },
          order: { seq: 'ASC' },
        })
      : [];
    const ordersByTask = new Map<string, TaskOrderEntity[]>();
    for (const order of orders) {
      ordersByTask.set(order.taskId, [
        ...(ordersByTask.get(order.taskId) ?? []),
        order,
      ]);
    }

    return {
      agvId: agv.id,
      vehicleName: agv.name,
      entries: rows.map((row) =>
        toTaskHistoryEntry(row, ordersByTask.get(row.task_id) ?? []),
      ),
      total,
      page,
      limit,
    };
  }

  async stateLog(
    id: string,
    query: AgvHistoryQueryDto = {},
  ): Promise<AgvStateLogResponse> {
    const agv = await this.requireAgv(id);
    const { page, limit, skip } = resolvePaging(query);

    const [transitions, total] = await this.transitionRepo.findAndCount({
      where: historyOf<VehicleStateTransitionEntity>(agv),
      order: { occurredAt: 'DESC', id: 'DESC' },
      skip,
      take: limit,
    });

    return {
      agvId: agv.id,
      vehicleName: agv.name,
      entries: transitions.map(toAgvStateChangeDto),
      total,
      page,
      limit,
    };
  }

  async errorHistory(
    id: string,
    query: AgvHistoryQueryDto = {},
  ): Promise<AgvErrorHistoryResponse> {
    const agv = await this.requireAgv(id);
    const { page, limit, skip } = resolvePaging(query);

    const [events, total] = await this.errorRepo.findAndCount({
      where: historyOf<VehicleErrorEventEntity>(agv),
      order: { occurredAt: 'DESC', id: 'DESC' },
      skip,
      take: limit,
    });

    return {
      agvId: agv.id,
      vehicleName: agv.name,
      errors: events.map(toAgvErrorEventDto),
      total,
      page,
      limit,
    };
  }

  async errorFrequency(
    query: AgvErrorFrequencyQueryDto = {},
  ): Promise<AgvErrorFrequencyResponse> {
    const window = query.window ?? DEFAULT_AGV_ERROR_WINDOW;
    const limit = query.limit ?? DEFAULT_ERROR_FREQUENCY_LIMIT;
    const to = new Date();
    const from = windowStart(to, window);

    const rows = await this.errorRepo
      .createQueryBuilder('event')
      .select('event.vehicleName', 'vehicle_name')
      .addSelect('event.mapRecordId', 'map_record_id')
      .addSelect('COUNT(*)::int', 'error_count')
      .addSelect('MAX(event.occurredAt)', 'last_occurred_at')
      .where('event.occurredAt >= :from', { from })
      .andWhere('event.occurredAt <= :to', { to })
      .andWhere('event.kind IN (:...kinds)', { kinds: FAULT_KINDS })
      .groupBy('event.vehicleName')
      .addGroupBy('event.mapRecordId')
      .orderBy('error_count', 'DESC')
      .addOrderBy('last_occurred_at', 'DESC')
      .limit(limit)
      .getRawMany<ErrorFrequencyRow>();

    const agvIdOf = await this.agvIdResolver();

    return {
      window,
      from,
      to,
      vehicles: rows.map((row) => this.toFrequencyEntry(row, agvIdOf)),
    };
  }

  private toFrequencyEntry(
    row: ErrorFrequencyRow,
    agvIdOf: (name: string, mapRecordId: string | null) => string | null,
  ): AgvErrorFrequencyEntry {
    return {
      agvId: agvIdOf(row.vehicle_name, row.map_record_id),
      vehicleName: row.vehicle_name,
      mapRecordId: row.map_record_id,
      errorCount: Number(row.error_count),
      lastOccurredAt: row.last_occurred_at,
    };
  }

  /** Tasks carry their map, so an AGV's history never picks up a same-named vehicle's tasks. */
  private taskHistoryFilter(
    agv: AgvEntity,
    query: AgvTaskHistoryQueryDto,
  ): SelectQueryBuilder<TransportTaskEntity> {
    const builder = this.taskRepo
      .createQueryBuilder('task')
      .leftJoin(TaskOrderEntity, 'task_order', 'task_order.task_id = task.id')
      .where(
        `(task_order.agv_id = :agvId OR (` +
          `NOT EXISTS (SELECT 1 FROM transport_request_orders owned_order ` +
          `WHERE owned_order.task_id = task.id) AND ` +
          `${ASSIGNED_VEHICLE_EXPRESSION} = :vehicleName))`,
        { agvId: agv.id, vehicleName: agv.name },
      )
      .distinct(true);
    if (agv.mapRecordId) {
      builder.andWhere('task.map_record_id = :mapRecordId', {
        mapRecordId: agv.mapRecordId,
      });
    }

    if (query.from) {
      builder.andWhere('task.createdAt >= :from', {
        from: new Date(query.from),
      });
    }
    if (query.to) {
      builder.andWhere('task.createdAt <= :to', { to: new Date(query.to) });
    }
    return builder;
  }

  /** AGV id for errors of `name` on `mapRecordId`; legacy mapless events only resolve when
   *  the name is unambiguous across maps. */
  private async agvIdResolver(): Promise<
    (name: string, mapRecordId: string | null) => string | null
  > {
    const agvs = await this.agvRepo.find({
      select: { id: true, name: true, mapRecordId: true },
    });
    return (name, mapRecordId) => {
      const named = agvs.filter((agv) => agv.name === name);
      const exact = named.find((agv) => agv.mapRecordId === mapRecordId);
      if (exact) return exact.id;
      return mapRecordId === null && named.length === 1 ? named[0].id : null;
    };
  }

  private async requireAgv(id: string): Promise<AgvEntity> {
    const agv = await this.agvRepo.findOne({ where: { id } });
    if (!agv) throw new NotFoundException('AGV không tồn tại.');
    return agv;
  }
}

/**
 * State log / error rows of this AGV: its own map's rows plus legacy rows recorded before the
 * map was stamped (those cannot be attributed, and hiding them would erase old history).
 */
function historyOf<
  T extends { vehicleName: string; mapRecordId: string | null },
>(agv: AgvEntity): FindOptionsWhere<T> | FindOptionsWhere<T>[] {
  if (!agv.mapRecordId) {
    return { vehicleName: agv.name } as FindOptionsWhere<T>;
  }
  return [
    { vehicleName: agv.name, mapRecordId: agv.mapRecordId },
    { vehicleName: agv.name, mapRecordId: IsNull() },
  ] as FindOptionsWhere<T>[];
}
