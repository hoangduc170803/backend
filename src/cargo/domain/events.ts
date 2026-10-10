import { TaskStatus } from '../entities/transport-task.entity';

export const TRANSPORT_TASK_EVENTS = {
  CREATED: 'transport-task.created',
  STATUS_CHANGED: 'transport-task.status-changed',
  COMPLETED: 'transport-task.completed',
  FAILED: 'transport-task.failed',
  UPDATED: 'transport-task.updated',
} as const;

export const TASK_ORDER_EVENTS = {
  ISSUED: 'task-order.issued',
  WITHDRAWING: 'task-order.withdrawing',
  WITHDRAWN: 'task-order.withdrawn',
  WITHDRAW_REFUSED: 'task-order.withdraw-refused',
  ENDED: 'task-order.ended',
  CHANGED: 'task-order.changed',
  REPLACED: 'task-order.replaced',
} as const;

export const ZONE_EVENTS = {
  SLOT_RELEASED: 'zone.slot-released',
  SLOT_CHANGED: 'zone.slot-changed',
} as const;

export const FMS_EVENTS = {
  TRANSPORT_ORDER_FINISHED: 'fms.transport-order.finished',
  /** Any kernel transport order's state/drive-order signature changed — manual orders included,
   *  unlike the task-scoped events above. Drives the operating screen's live Order panel. */
  TRANSPORT_ORDER_CHANGED: 'fms.transport-order.changed',
  DROPOFF_UNLOADED: 'fms.transport-order.dropoff-unloaded',
  TASK_ORDER_STATE_CHANGED: 'fms.transport-order.task-order-state',
  VEHICLE_AVAILABLE: 'fms.vehicle.available',
  VEHICLE_ERROR_CHANGED: 'fms.vehicle.error-changed',
  /** A different map record was just loaded into the kernel — every vehicle/order/cargo/area an
   *  operating client has cached belongs to the map that was just replaced. */
  MAP_LOADED: 'fms.map.loaded',
  PLANT_MODEL_REPLACING: 'fms.plant-model.replacing',
  PLANT_MODEL_REPLACED: 'fms.plant-model.replaced',
  KERNEL_CONNECTED: 'fms.kernel.connected',
} as const;

export const ENVIRONMENTAL_ENTITY_EVENTS = {
  CHANGED: 'environmental-entity.changed',
} as const;

export class FmsPlantModelReplacedEvent {
  constructor(
    readonly reason: string,
    readonly succeeded = true,
  ) {}
}

export const KERNEL_SESSION_EVENTS = {
  CHANGED: 'kernel-session.changed',
  READY: 'kernel-session.ready',
} as const;

export type TaskLeg = 'PICKUP' | 'APPROACH' | 'DROPOFF';

export class TransportTaskCreatedEvent {
  constructor(
    readonly taskId: string,
    readonly cargoId: string | null,
  ) {}
}

export class TransportTaskStatusChangedEvent {
  constructor(
    readonly taskId: string,
    readonly from: TaskStatus,
    readonly to: TaskStatus,
    readonly cargoId: string | null,
  ) {}
}

export class TransportTaskCompletedEvent {
  constructor(
    readonly taskId: string,
    readonly cargoId: string | null,
  ) {}
}

export class TransportTaskFailedEvent {
  constructor(
    readonly taskId: string,
    readonly cargoId: string | null,
  ) {}
}

/** A task's metadata changed without a status transition (e.g. unloaded-at, soft-delete) —
 *  still needs to reach the same listeners a status change would, so the UI doesn't go stale. */
export class TransportTaskUpdatedEvent {
  constructor(
    readonly taskId: string,
    readonly cargoId: string | null,
  ) {}
}

export class FmsTransportOrderFinishedEvent {
  constructor(
    readonly orderName: string,
    readonly taskId: string,
    readonly leg: TaskLeg,
  ) {}
}

export class FmsDropOffUnloadedEvent {
  constructor(
    readonly orderName: string,
    readonly taskId: string,
  ) {}
}

export class FmsVehicleAvailableEvent {
  constructor(readonly vehicleName: string) {}
}

export type VehicleErrorChangeKind = 'RAISED' | 'CHANGED' | 'CLEARED';

export class FmsVehicleErrorChangedEvent {
  constructor(
    readonly vehicleName: string,
    readonly kind: VehicleErrorChangeKind,
    readonly fatal: string[],
    readonly warning: string[],
    readonly vehicleState: string,
    readonly pointName: string | null,
    readonly transportOrderName: string | null,
    readonly observedAt: string | null,
  ) {}
}

export class FmsMapLoadedEvent {
  constructor(readonly mapRecordId: string) {}
}

export class TaskOrderIssuedEvent {
  constructor(
    readonly taskId: string,
    readonly orderName: string,
    readonly leg: string,
    readonly vehicleName: string | null,
    readonly destinations: readonly {
      locationName: string;
      operation: string;
    }[],
  ) {}
}

export class TaskOrderChangedEvent {
  constructor(readonly orderName: string) {}
}

export class TaskOrderWithdrawingEvent {
  constructor(
    readonly orderName: string,
    readonly reason: string | null,
    readonly replacedBy: string | null,
  ) {}
}

export class FmsTaskOrderStateEvent {
  constructor(
    readonly orderName: string,
    readonly taskId: string | null,
    readonly leg: string | null,
    readonly orderState: string,
    readonly processingVehicle: string | null,
    readonly finishedDriveOrders: number | null = null,
  ) {}
}

export const KERNEL_ORDER_LOST = 'LOST';

export type TaskOrderOutcome =
  | 'STARTED'
  | 'FINISHED'
  | 'FAILED'
  | 'PREEMPTED'
  | 'WITHDRAWN_EXTERNALLY'
  | 'LOST';

export class TaskOrderEndedEvent {
  constructor(
    readonly taskId: string,
    readonly orderName: string,
    readonly leg: string,
    readonly outcome: TaskOrderOutcome,
    readonly vehicleName: string | null,
  ) {}
}

export class TaskOrderReplacedEvent {
  constructor(
    readonly oldOrderName: string,
    readonly newOrderName: string,
    readonly vehicleName: string | null,
  ) {}
}
