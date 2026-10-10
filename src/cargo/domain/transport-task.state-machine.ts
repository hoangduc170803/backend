import {
  TaskKind,
  TaskStatus,
  TransportTaskEntity,
} from '../entities/transport-task.entity';

export class InvalidTransportTaskTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid transport task transition: ${from} → ${to}`);
    this.name = 'InvalidTransportTaskTransitionError';
  }
}

type TransitionTable = Record<TaskStatus, readonly TaskStatus[]>;

const NO_TRANSITIONS: TransitionTable = {
  [TaskStatus.CREATED]: [],
  [TaskStatus.READY_TO_ASSIGN]: [],
  [TaskStatus.BLOCKED]: [],
  [TaskStatus.PICKING_UP]: [],
  [TaskStatus.DELIVERING]: [],
  [TaskStatus.DELIVERY_COMPLETED]: [],
  [TaskStatus.CANCELLED]: [],
  [TaskStatus.FAILED]: [],
  [TaskStatus.EXECUTING]: [],
  [TaskStatus.COMPLETED]: [],
};

const CARGO_TRANSITIONS: TransitionTable = {
  ...NO_TRANSITIONS,
  [TaskStatus.CREATED]: [
    TaskStatus.READY_TO_ASSIGN,
    TaskStatus.BLOCKED,
    TaskStatus.CANCELLED,
    TaskStatus.FAILED,
  ],
  [TaskStatus.READY_TO_ASSIGN]: [
    TaskStatus.PICKING_UP,
    TaskStatus.BLOCKED,
    TaskStatus.CANCELLED,
    TaskStatus.FAILED,
  ],
  [TaskStatus.BLOCKED]: [
    TaskStatus.READY_TO_ASSIGN,
    TaskStatus.CANCELLED,
    TaskStatus.FAILED,
  ],
  [TaskStatus.PICKING_UP]: [
    TaskStatus.DELIVERING,
    TaskStatus.READY_TO_ASSIGN,
    TaskStatus.BLOCKED,
    TaskStatus.CANCELLED,
    TaskStatus.FAILED,
  ],
  [TaskStatus.DELIVERING]: [
    TaskStatus.DELIVERY_COMPLETED,
    TaskStatus.CANCELLED,
    TaskStatus.FAILED,
  ],
};

const DIRECT_TRANSITIONS: TransitionTable = {
  ...NO_TRANSITIONS,
  [TaskStatus.CREATED]: [
    TaskStatus.EXECUTING,
    TaskStatus.COMPLETED,
    TaskStatus.CANCELLED,
    TaskStatus.FAILED,
  ],
  [TaskStatus.EXECUTING]: [
    TaskStatus.COMPLETED,
    TaskStatus.CANCELLED,
    TaskStatus.FAILED,
  ],
};

function tableFor(kind: TaskKind): TransitionTable {
  return kind === TaskKind.CARGO ? CARGO_TRANSITIONS : DIRECT_TRANSITIONS;
}

export class TransportTaskStateMachine {
  static canTransition(
    from: TaskStatus,
    to: TaskStatus,
    kind: TaskKind = TaskKind.CARGO,
  ): boolean {
    return tableFor(kind)[from]?.includes(to) ?? false;
  }

  static isCancellable(
    status: TaskStatus,
    kind: TaskKind = TaskKind.CARGO,
  ): boolean {
    return this.canTransition(status, TaskStatus.CANCELLED, kind);
  }

  static isTerminal(status: TaskStatus, kind: TaskKind = TaskKind.CARGO) {
    return tableFor(kind)[status].length === 0;
  }

  static transition(task: TransportTaskEntity, to: TaskStatus): void {
    if (!this.canTransition(task.status, to, task.kind ?? TaskKind.CARGO)) {
      throw new InvalidTransportTaskTransitionError(task.status, to);
    }
    task.status = to;
  }
}
