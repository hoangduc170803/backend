import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { TaskOrderEntity } from '../../cargo/entities/task-order.entity';
import { TransportTaskEntity } from '../../cargo/entities/transport-task.entity';
import { CargoEntity } from '../../cargo/entities/cargo.entity';
import { MapRecordEntity } from '../../maps/infrastructure/entities/map-record.entity';
import { applyRegistryColumnFilters } from './registry-table-filters';
import { ActiveMapContext } from '../../maps/infrastructure/active-map-context.service';
import { MapNameLookup } from '../../maps/infrastructure/map-name-lookup.service';
import type {
  ListTransportOrdersQueryDto,
  TransportOrderRegistryListDto,
} from '../dto/operating.dto';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 50;
const ORDER_COLUMNS: Record<string, string> = {
  order: 'o.order_name',
  leg: 'o.leg',
  state: 'o.state',
  vehicle: 'o.vehicle_name',
  destinations: 'o.destinations::text',
  task: 'task.request_code',
  cargo: 'cargo.item_code',
  map: 'map.name',
  created: 'o.created_at',
  ended: 'o.ended_at',
};

interface OrderRow {
  order: TaskOrderEntity;
  requestCode: string | null;
  taskKind: string | null;
  taskStatus: string | null;
  itemCode: string | null;
  mapRecordId: string | null;
}

/**
 * Every transport order WES has sent to openTCS (`transport_request_orders`), across every map —
 * the kernel only knows the loaded map's orders, so this is the only full-history view. The map
 * comes from the task that owns the order.
 */
@Injectable()
export class TransportOrderRegistryService {
  constructor(
    @InjectRepository(TaskOrderEntity)
    private readonly orderRepo: Repository<TaskOrderEntity>,
    private readonly activeMap: ActiveMapContext,
    private readonly mapNames: MapNameLookup,
  ) {}

  /** `mapIds`: the caller's AUTH-3 map scope (`undefined` = unrestricted). */
  async list(
    query: ListTransportOrdersQueryDto,
    mapIds?: string[],
  ): Promise<TransportOrderRegistryListDto> {
    const page = query.page ?? DEFAULT_PAGE;
    const limit = query.limit ?? DEFAULT_LIMIT;
    if (mapIds?.length === 0) return { orders: [], total: 0, page, limit };

    const builder = this.orderRepo
      .createQueryBuilder('o')
      .leftJoin(TransportTaskEntity, 'task', 'task.id = o.task_id')
      .leftJoin(CargoEntity, 'cargo', 'cargo.id = task.cargo_id')
      .leftJoin(MapRecordEntity, 'map', 'map.id = task.map_record_id')
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
    if (query.state?.length) {
      builder.andWhere('o.state IN (:...states)', { states: query.state });
    }
    if (query.leg?.length) {
      builder.andWhere('o.leg IN (:...legs)', { legs: query.leg });
    }
    const search = query.search?.trim();
    if (search) {
      const pattern = `%${search}%`;
      builder.andWhere(
        new Brackets((match) =>
          match
            .where('o.order_name ILIKE :pattern', { pattern })
            .orWhere('o.vehicle_name ILIKE :pattern', { pattern })
            .orWhere('task.request_code ILIKE :pattern', { pattern })
            .orWhere('cargo.item_code ILIKE :pattern', { pattern }),
        ),
      );
    }

    applyRegistryColumnFilters(builder, query.columnFilters, ORDER_COLUMNS, [
      'created',
      'ended',
    ]);
    const total = await builder.getCount();
    const raw = await builder
      .select('o')
      .addSelect('task.request_code', 'request_code')
      .addSelect('task.kind', 'task_kind')
      .addSelect('task.status', 'task_status')
      .addSelect('task.map_record_id', 'map_record_id')
      .addSelect('cargo.item_code', 'item_code')
      .orderBy(
        query.sortBy && ORDER_COLUMNS[query.sortBy]
          ? ORDER_COLUMNS[query.sortBy]
          : ORDER_COLUMNS.created,
        query.sortDir === 'asc' ? 'ASC' : 'DESC',
      )
      .addOrderBy('o.id', 'DESC')
      .offset((page - 1) * limit)
      .limit(limit)
      .getRawAndEntities();

    const rows: OrderRow[] = raw.entities.map((order) => {
      const extra = raw.raw.find(
        (row: Record<string, unknown>) => row.o_id === order.id,
      ) as Record<string, string | null> | undefined;
      return {
        order,
        requestCode: extra?.request_code ?? null,
        taskKind: extra?.task_kind ?? null,
        taskStatus: extra?.task_status ?? null,
        itemCode: extra?.item_code ?? null,
        mapRecordId: extra?.map_record_id ?? null,
      };
    });
    const [names, loadedMapId] = await Promise.all([
      this.mapNames.namesOf(rows.map((row) => row.mapRecordId)),
      this.activeMap.id(),
    ]);

    return {
      orders: rows.map(({ order, mapRecordId, ...task }) => ({
        orderName: order.orderName,
        leg: order.leg,
        seq: order.seq,
        state: order.state,
        kernelState: order.kernelState,
        vehicleName: order.vehicleName,
        agvId: order.agvId,
        destinations: order.destinations ?? [],
        replacedBy: order.replacedBy,
        replacementOrderId: order.replacementOrderId,
        endReason: order.endReason,
        createdAt: order.createdAt.toISOString(),
        startedAt: order.startedAt?.toISOString() ?? null,
        endedAt: order.endedAt?.toISOString() ?? null,
        taskId: order.taskId,
        ...task,
        mapRecordId,
        mapName: mapRecordId ? (names.get(mapRecordId) ?? null) : null,
        onLoadedMap: mapRecordId !== null && mapRecordId === loadedMapId,
      })),
      total,
      page,
      limit,
    };
  }
}
