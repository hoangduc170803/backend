import {
  TaskKind,
  TaskStatus,
  type TransportTaskEntity,
} from '../../cargo/entities/transport-task.entity';
import type { CargoEntity } from '../../cargo/entities/cargo.entity';
import {
  TaskOrderState,
  type TaskOrderEntity,
} from '../../cargo/entities/task-order.entity';
import type {
  TaskDto,
  TaskLegDto,
  TaskLegKind,
  TaskOrderHistoryDto,
} from '../dto/operating.dto';
import { recreationNotice } from '../../cargo/domain/order-recreation';

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  TaskStatus.DELIVERY_COMPLETED,
  TaskStatus.COMPLETED,
  TaskStatus.CANCELLED,
  TaskStatus.FAILED,
];

const CARGO_LEGS: readonly TaskLegKind[] = ['PICKUP', 'APPROACH', 'DROPOFF'];

const DIRECT_LEG: Readonly<Partial<Record<TaskKind, TaskLegKind>>> = {
  [TaskKind.MANUAL]: 'MANUAL',
  [TaskKind.PARK]: 'PARK',
  [TaskKind.CHARGE]: 'CHARGE',
};

export interface TaskViewSources {
  readonly cargo: CargoEntity | null;
  readonly destinationZoneName: string | null;
  readonly failureReason: string | null;
  readonly orders?: readonly TaskOrderEntity[];
}

function legsFromMetadata(task: TransportTaskEntity): TaskLegDto[] {
  const metadata = task.metadata ?? {};
  const legs: Array<[TaskLegKind, string | undefined]> = [
    ['PICKUP', metadata.pickupOrderName],
    ['APPROACH', metadata.approachOrderName],
    ['DROPOFF', metadata.dropoffOrderName],
  ];
  return legs.flatMap(([kind, orderName]) =>
    orderName ? [{ kind, orderName }] : [],
  );
}

export function legsOf(
  task: TransportTaskEntity,
  orders: readonly TaskOrderEntity[] = [],
): TaskLegDto[] {
  const latestByLeg = new Map<string, TaskOrderEntity>();
  for (const order of orders) {
    if (order.state === TaskOrderState.REPLACED) continue;
    const current = latestByLeg.get(order.leg);
    if (!current || order.seq > current.seq) latestByLeg.set(order.leg, order);
  }
  if (latestByLeg.size === 0) return legsFromMetadata(task);

  const direct = DIRECT_LEG[task.kind];
  const sequence = direct ? [direct] : CARGO_LEGS;
  return sequence.flatMap((kind) => {
    const order = latestByLeg.get(kind);
    return order
      ? [{ kind, orderName: order.orderName, state: order.state }]
      : [];
  });
}

export function currentLegOf(
  task: TransportTaskEntity,
  orders: readonly TaskOrderEntity[] = [],
): TaskLegKind | null {
  const direct = DIRECT_LEG[task.kind];
  if (direct) {
    return task.status === TaskStatus.CREATED ||
      task.status === TaskStatus.EXECUTING
      ? direct
      : null;
  }
  if (task.status === TaskStatus.PICKING_UP) return 'PICKUP';
  if (task.status !== TaskStatus.DELIVERING) return null;
  const activeLegs = new Set(
    orders
      .filter((order) => order.state === TaskOrderState.ACTIVE)
      .map((order) => order.leg),
  );
  if (activeLegs.has('DROPOFF')) return 'DROPOFF';
  if (activeLegs.has('APPROACH')) return 'APPROACH';
  return task.metadata?.dropoffOrderName ? 'DROPOFF' : 'APPROACH';
}

export function toOrderHistory(
  orders: readonly TaskOrderEntity[],
): TaskOrderHistoryDto[] {
  return orders.map((order) => ({
    leg: order.leg,
    orderName: order.orderName,
    state: order.state,
    vehicleName: order.vehicleName,
    replacedBy: order.replacedBy,
    endReason: order.endReason,
    kernelState: order.kernelState,
    createdAt: order.createdAt.toISOString(),
    startedAt: order.startedAt?.toISOString() ?? null,
    endedAt: order.endedAt?.toISOString() ?? null,
  }));
}

export function toTaskDto(
  task: TransportTaskEntity,
  { cargo, destinationZoneName, failureReason, orders = [] }: TaskViewSources,
): TaskDto {
  return {
    taskId: task.id,
    requestCode: task.requestCode,
    kind: task.kind ?? TaskKind.CARGO,
    status: task.status,
    cargoId: task.cargoId,
    itemCode: cargo?.itemCode ?? null,
    vehicle:
      [...orders]
        .reverse()
        .find(
          (order) => order.state === TaskOrderState.ACTIVE && order.vehicleName,
        )?.vehicleName ??
      task.metadata?.assignedVehicleName ??
      null,
    pickupPointName: cargo?.sourcePointName ?? null,
    pickupLocationName: cargo?.sourcePickupLocationName ?? null,
    destinationZoneId: cargo?.destinationZoneId ?? null,
    destinationZoneName,
    dropLocationName: cargo?.destinationLocationName ?? null,
    currentLeg: currentLegOf(task, orders),
    legs: legsOf(task, orders),
    blockedReason:
      task.metadata?.blockedReason ??
      (TERMINAL_TASK_STATUSES.includes(task.status)
        ? null
        : recreationNotice(task.metadata?.orderRecreation, new Date())),
    failureReason,
    createdAt: task.createdAt.toISOString(),
    assignedAt: task.assignedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    cancelledAt: task.cancelledAt?.toISOString() ?? null,
    updatedAt: task.updatedAt.toISOString(),
  };
}
