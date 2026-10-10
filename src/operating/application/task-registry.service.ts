import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository, type SelectQueryBuilder } from 'typeorm';
import { TransportTaskEntity } from '../../cargo/entities/transport-task.entity';
import { CargoEntity } from '../../cargo/entities/cargo.entity';
import { TaskStatusTransitionEntity } from '../../cargo/entities/task-status-transition.entity';
import { MapRecordEntity } from '../../maps/infrastructure/entities/map-record.entity';
import { ZoneEntity } from '../../zones/entities/zone.entity';
import { applyRegistryColumnFilters } from './registry-table-filters';
import { ActiveMapContext } from '../../maps/infrastructure/active-map-context.service';
import { TaskViewAssembler } from './task-view.assembler';
import { TaskOrderService } from '../../cargo/task-order.service';
import { toOrderHistory } from '../domain/task-view';
import type {
  ListTasksQueryDto,
  TaskDto,
  TaskRegistryDetailDto,
  TaskRegistryItemDto,
  TaskRegistryListDto,
} from '../dto/operating.dto';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 50;
const TASK_COLUMNS: Record<string, string> = {
  code: 'task.request_code',
  kind: 'task.kind::text',
  cargo: 'cargo.item_code',
  map: 'map.name',
  status: 'task.status::text',
  vehicle: "task.metadata->>'assignedVehicleName'",
  pickup: 'cargo.source_point_name',
  destination: 'zone.name',
  leg: `CASE WHEN task.kind <> 'CARGO' AND task.status IN ('CREATED', 'EXECUTING') THEN task.kind::text WHEN task.status = 'PICKING_UP' THEN 'PICKUP' WHEN task.status = 'DELIVERING' THEN CASE WHEN task.metadata->>'dropoffOrderName' IS NULL THEN 'APPROACH' ELSE 'DROPOFF' END END`,
  created: 'task.created_at',
  finished: 'COALESCE(task.completed_at, task.cancelled_at)',
};

@Injectable()
export class TaskRegistryService {
  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    @InjectRepository(MapRecordEntity)
    private readonly mapRepo: Repository<MapRecordEntity>,
    @InjectRepository(TaskStatusTransitionEntity)
    private readonly transitionRepo: Repository<TaskStatusTransitionEntity>,
    private readonly views: TaskViewAssembler,
    private readonly taskOrders: TaskOrderService,
    private readonly activeMap: ActiveMapContext,
  ) {}

  async list(
    query: ListTasksQueryDto,
    mapIds?: string[],
  ): Promise<TaskRegistryListDto> {
    const page = query.page ?? DEFAULT_PAGE;
    const limit = query.limit ?? DEFAULT_LIMIT;
    if (mapIds?.length === 0) return { tasks: [], total: 0, page, limit };

    const builder = this.filtered(query, mapIds);
    applyRegistryColumnFilters(builder, query.columnFilters, TASK_COLUMNS, [
      'created',
      'finished',
    ]);
    const sort =
      query.sortBy && TASK_COLUMNS[query.sortBy]
        ? TASK_COLUMNS[query.sortBy]
        : TASK_COLUMNS.created;
    const [tasks, total] = await builder
      .orderBy(sort, query.sortDir === 'asc' ? 'ASC' : 'DESC')
      .addOrderBy('task.id', 'DESC')
      .offset((page - 1) * limit)
      .limit(limit)
      .getManyAndCount();

    return { tasks: await this.withMaps(tasks), total, page, limit };
  }

  async detail(
    taskId: string,
    mapIds?: string[],
  ): Promise<TaskRegistryDetailDto> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    const visible =
      task &&
      (mapIds === undefined ||
        (!!task.mapRecordId && mapIds.includes(task.mapRecordId)));
    if (!visible) throw new NotFoundException('Không tìm thấy nhiệm vụ.');

    const [item] = await this.withMaps([task]);
    const cargo = task.cargoId
      ? await this.cargoRepo.findOne({
          where: { id: task.cargoId },
          withDeleted: true,
        })
      : null;
    const transitions = await this.transitionRepo.find({
      where: { taskId: task.id },
      order: { occurredAt: 'ASC' },
    });
    const orders = await this.taskOrders.ordersOf([task.id]);

    return {
      ...item,
      startedAt: task.startedAt?.toISOString() ?? null,
      dropPointName: cargo?.destinationLocationName ?? null,
      cargoStatus: cargo?.status ?? null,
      transitions: transitions.map((transition) => ({
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
        trigger: transition.trigger,
        vehicleName: transition.vehicleName,
        reason: transition.reason,
        occurredAt: transition.occurredAt.toISOString(),
      })),
      orders: toOrderHistory(orders),
    };
  }

  private filtered(
    query: ListTasksQueryDto,
    mapIds: string[] | undefined,
  ): SelectQueryBuilder<TransportTaskEntity> {
    const builder = this.taskRepo
      .createQueryBuilder('task')
      .leftJoin(CargoEntity, 'cargo', 'cargo.id = task.cargo_id')
      .leftJoin(MapRecordEntity, 'map', 'map.id = task.map_record_id')
      .leftJoin(ZoneEntity, 'zone', 'zone.id = cargo.destination_zone_id')
      .withDeleted();

    if (mapIds !== undefined) {
      builder.andWhere('task.map_record_id IN (:...mapIds)', { mapIds });
    }
    if (query.mapRecordId) {
      builder.andWhere('task.map_record_id = :mapRecordId', {
        mapRecordId: query.mapRecordId,
      });
    }
    if (query.mapRecordIds?.length) {
      builder.andWhere('task.map_record_id IN (:...selectedMapIds)', {
        selectedMapIds: query.mapRecordIds,
      });
    }
    if (query.kind?.length) {
      builder.andWhere('task.kind IN (:...kinds)', { kinds: query.kind });
    }
    if (query.status?.length) {
      builder.andWhere('task.status IN (:...statuses)', {
        statuses: query.status,
      });
    }
    const search = query.search?.trim();
    if (search) {
      const pattern = `%${search}%`;
      builder.andWhere(
        new Brackets((matches) =>
          matches
            .where('task.request_code ILIKE :pattern', { pattern })
            .orWhere('cargo.item_code ILIKE :pattern', { pattern })
            .orWhere(`task.metadata->>'assignedVehicleName' ILIKE :pattern`, {
              pattern,
            }),
        ),
      );
    }
    return builder;
  }

  private async withMaps(
    tasks: readonly TransportTaskEntity[],
  ): Promise<TaskRegistryItemDto[]> {
    const views = await this.views.assemble(tasks);
    const mapNameById = await this.mapNamesOf(tasks);
    const loadedMapId = await this.activeMap.id();

    return tasks.map((task, index) =>
      withMap(views[index], task.mapRecordId, mapNameById, loadedMapId),
    );
  }

  private async mapNamesOf(
    tasks: readonly TransportTaskEntity[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        tasks.flatMap((task) => (task.mapRecordId ? [task.mapRecordId] : [])),
      ),
    ];
    if (ids.length === 0) return new Map();
    const maps = await this.mapRepo.find({
      where: { id: In(ids) },
      select: { id: true, name: true },
      withDeleted: true,
    });
    return new Map(maps.map((map) => [map.id, map.name]));
  }
}

function withMap(
  view: TaskDto,
  mapRecordId: string | null,
  mapNameById: ReadonlyMap<string, string>,
  loadedMapId: string | null,
): TaskRegistryItemDto {
  return {
    ...view,
    mapRecordId,
    mapName: mapRecordId ? (mapNameById.get(mapRecordId) ?? null) : null,
    onLoadedMap: !!mapRecordId && mapRecordId === loadedMapId,
  };
}
