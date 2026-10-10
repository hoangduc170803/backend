import { In, Repository } from 'typeorm';
import {
  TaskKind,
  TaskStatus,
  TransportTaskEntity,
} from './entities/transport-task.entity';

const ACTIVE_TASK_STATUSES = [TaskStatus.PICKING_UP, TaskStatus.DELIVERING];
const OCCUPYING_DIRECT_KINDS = [TaskKind.MANUAL, TaskKind.CHARGE];
const LIVE_DIRECT_STATUSES = [TaskStatus.CREATED, TaskStatus.EXECUTING];

export function busyTaskWhere(mapRecordId: string) {
  return [
    { status: In(ACTIVE_TASK_STATUSES), mapRecordId },
    {
      kind: In(OCCUPYING_DIRECT_KINDS),
      status: In(LIVE_DIRECT_STATUSES),
      mapRecordId,
    },
  ];
}

export async function activeCargoVehicleNames(
  taskRepo: Repository<TransportTaskEntity>,
  mapRecordId: string,
): Promise<Set<string>> {
  const tasks = await taskRepo.find({ where: busyTaskWhere(mapRecordId) });
  const names = new Set<string>();
  for (const task of tasks) {
    const name = task.metadata?.assignedVehicleName;
    if (name) names.add(name);
  }
  return names;
}

/** Before this, a cargo's item is still physically sitting at its source point. */
export const PICKUP_NOT_YET_LOADED_STATUSES = [
  TaskStatus.CREATED,
  TaskStatus.READY_TO_ASSIGN,
  TaskStatus.BLOCKED,
  TaskStatus.PICKING_UP,
];

export function isStillAtSource(status: TaskStatus | undefined): boolean {
  return (
    status !== undefined && PICKUP_NOT_YET_LOADED_STATUSES.includes(status)
  );
}

/** A terminal failed/cancelled task can no longer deliver its cargo into the destination zone. */
export function holdsDestinationCapacity(
  status: TaskStatus | undefined,
): boolean {
  return status !== TaskStatus.FAILED && status !== TaskStatus.CANCELLED;
}

export async function latestTaskByCargoId(
  taskRepo: Repository<TransportTaskEntity>,
  cargoIds: readonly string[],
): Promise<Map<string, TransportTaskEntity>> {
  if (cargoIds.length === 0) return new Map();
  const tasks = await taskRepo.find({
    where: { cargoId: In([...cargoIds]) },
    order: { createdAt: 'DESC', id: 'DESC' },
  });
  const latest = new Map<string, TransportTaskEntity>();
  for (const task of tasks) {
    if (task.cargoId && !latest.has(task.cargoId)) {
      latest.set(task.cargoId, task);
    }
  }
  return latest;
}

export async function latestTaskStatusByCargoId(
  taskRepo: Repository<TransportTaskEntity>,
  cargoIds: readonly string[],
): Promise<Map<string, TaskStatus>> {
  const latestTasks = await latestTaskByCargoId(taskRepo, cargoIds);
  const latestStatuses = new Map<string, TaskStatus>();
  for (const [cargoId, task] of latestTasks) {
    latestStatuses.set(cargoId, task.status);
  }
  return latestStatuses;
}
