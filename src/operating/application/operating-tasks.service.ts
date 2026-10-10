import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, type SelectQueryBuilder } from 'typeorm';
import { Observable, Subject } from 'rxjs';
import { TransportTaskEntity } from '../../cargo/entities/transport-task.entity';
import { TRANSPORT_TASK_EVENTS } from '../../cargo/domain/events';
import { ActiveMapContext } from '../../maps/infrastructure/active-map-context.service';
import { MapNameLookup } from '../../maps/infrastructure/map-name-lookup.service';
import {
  resolveMapFilter,
  type MapScopeQueryDto,
} from '../../maps/domain/map-scope';
import { TERMINAL_TASK_STATUSES } from '../domain/task-view';
import { TaskViewAssembler } from './task-view.assembler';
import type { TaskListDto } from '../dto/operating.dto';

/** Safety bound on tasks still being worked on — far above any real backlog; hitting it sets
 *  `truncated` instead of silently dropping a running task behind newer ones. */
const ACTIVE_LIST_LIMIT = 5_000;
/** Tasks that just ended stay on the operating list for context; history is the task registry. */
const RECENT_FINISHED_LIMIT = 100;
const FINISHED_TASK_WINDOW_MS = 24 * 60 * 60 * 1000;
const EMPTY_LIST: TaskListDto = { tasks: [], total: 0, truncated: false };

@Injectable()
export class OperatingTasksService {
  private readonly ticks = new Subject<void>();

  constructor(
    @InjectRepository(TransportTaskEntity)
    private readonly taskRepo: Repository<TransportTaskEntity>,
    private readonly views: TaskViewAssembler,
    private readonly activeMap: ActiveMapContext,
    private readonly mapNames: MapNameLookup,
  ) {}

  get changes$(): Observable<void> {
    return this.ticks.asObservable();
  }

  @OnEvent(TRANSPORT_TASK_EVENTS.CREATED)
  @OnEvent(TRANSPORT_TASK_EVENTS.STATUS_CHANGED)
  @OnEvent(TRANSPORT_TASK_EVENTS.COMPLETED)
  @OnEvent(TRANSPORT_TASK_EVENTS.FAILED)
  @OnEvent(TRANSPORT_TASK_EVENTS.UPDATED)
  onTaskChanged(): void {
    this.ticks.next();
  }

  async list(
    query: MapScopeQueryDto = {},
    mapIds?: string[],
  ): Promise<TaskListDto> {
    const loadedMapId = await this.activeMap.id();
    const filter = resolveMapFilter(query, loadedMapId, mapIds);
    if (filter.ids !== null && filter.ids.length === 0) return EMPTY_LIST;

    const { tasks, total } = await this.visibleTasks(filter.ids);
    const [views, names] = await Promise.all([
      this.views.assemble(tasks),
      this.mapNames.namesOf(tasks.map((task) => task.mapRecordId)),
    ]);
    return {
      tasks: views.map((view, index) => {
        const mapRecordId = tasks[index].mapRecordId;
        return {
          ...view,
          mapRecordId,
          mapName: mapRecordId ? (names.get(mapRecordId) ?? null) : null,
          onLoadedMap: mapRecordId !== null && mapRecordId === loadedMapId,
        };
      }),
      total,
      truncated: total > tasks.length,
    };
  }

  /**
   * How many tasks of one map sit in each status: every task still being worked on, plus the
   * ones that ended within the last day — the same window the operating list shows.
   */
  async statusCounts(mapRecordId: string): Promise<Record<string, number>> {
    const finishedSince = new Date(Date.now() - FINISHED_TASK_WINDOW_MS);
    const rows = await this.scoped([mapRecordId])
      .select('task.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .andWhere(
        new Brackets((visible) =>
          visible
            .where('task.status NOT IN (:...terminal)', {
              terminal: TERMINAL_TASK_STATUSES,
            })
            .orWhere('task.updated_at >= :finishedSince', { finishedSince }),
        ),
      )
      .groupBy('task.status')
      .getRawMany<{ status: string; count: string }>();
    return Object.fromEntries(
      rows.map((row) => [row.status, Number(row.count)]),
    );
  }

  /**
   * Every task still being worked on, however old, plus the most recent ones that ended. The two
   * are read separately so a burst of new tasks can never push a running one off the list.
   * `mapIds: null` = every map, legacy tasks without one included.
   */
  private async visibleTasks(
    mapIds: string[] | null,
  ): Promise<{ tasks: TransportTaskEntity[]; total: number }> {
    const finishedSince = new Date(Date.now() - FINISHED_TASK_WINDOW_MS);
    const [[active, activeTotal], [finished, finishedTotal]] =
      await Promise.all([
        this.scoped(mapIds)
          .andWhere('task.status NOT IN (:...terminal)', {
            terminal: TERMINAL_TASK_STATUSES,
          })
          .orderBy('task.created_at', 'DESC')
          .addOrderBy('task.id', 'DESC')
          .take(ACTIVE_LIST_LIMIT)
          .getManyAndCount(),
        this.scoped(mapIds)
          .andWhere('task.status IN (:...terminal)', {
            terminal: TERMINAL_TASK_STATUSES,
          })
          .andWhere('task.updated_at >= :finishedSince', { finishedSince })
          .orderBy('task.updated_at', 'DESC')
          .addOrderBy('task.id', 'DESC')
          .take(RECENT_FINISHED_LIMIT)
          .getManyAndCount(),
      ]);
    const tasks = [...active, ...finished].sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.id.localeCompare(a.id),
    );
    return { tasks, total: activeTotal + finishedTotal };
  }

  private scoped(
    mapIds: string[] | null,
  ): SelectQueryBuilder<TransportTaskEntity> {
    const builder = this.taskRepo.createQueryBuilder('task');
    if (mapIds !== null) {
      builder.where('task.map_record_id IN (:...mapIds)', { mapIds });
    }
    return builder;
  }
}
