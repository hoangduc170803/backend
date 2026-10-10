import {
  TaskKind,
  TaskStatus,
  TransportTaskEntity,
} from '../entities/transport-task.entity';
import {
  TransportTaskStateMachine,
  InvalidTransportTaskTransitionError,
} from './transport-task.state-machine';

const task = (status: TaskStatus): TransportTaskEntity =>
  ({ status }) as TransportTaskEntity;

const ALL_STATUSES = Object.values(TaskStatus);

// from → the only transitions the lifecycle allows
const VALID: Record<TaskStatus, TaskStatus[]> = {
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
  [TaskStatus.DELIVERY_COMPLETED]: [],
  [TaskStatus.CANCELLED]: [],
  [TaskStatus.FAILED]: [],
  [TaskStatus.EXECUTING]: [],
  [TaskStatus.COMPLETED]: [],
};

const DIRECT_VALID: Partial<Record<TaskStatus, TaskStatus[]>> = {
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

describe('TransportTaskStateMachine', () => {
  describe('canTransition', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const allowed = VALID[from].includes(to);
        it(`${allowed ? 'allows' : 'rejects'} ${from} → ${to}`, () => {
          expect(TransportTaskStateMachine.canTransition(from, to)).toBe(
            allowed,
          );
        });
      }
    }
  });

  describe('isCancellable', () => {
    it('is true only for non-terminal active states', () => {
      const cancellable = ALL_STATUSES.filter((s) =>
        TransportTaskStateMachine.isCancellable(s),
      );
      expect(cancellable.sort()).toEqual(
        [
          TaskStatus.CREATED,
          TaskStatus.READY_TO_ASSIGN,
          TaskStatus.BLOCKED,
          TaskStatus.PICKING_UP,
          TaskStatus.DELIVERING,
        ].sort(),
      );
    });

    it('is false for terminal states', () => {
      expect(
        TransportTaskStateMachine.isCancellable(TaskStatus.DELIVERY_COMPLETED),
      ).toBe(false);
      expect(
        TransportTaskStateMachine.isCancellable(TaskStatus.CANCELLED),
      ).toBe(false);
      expect(TransportTaskStateMachine.isCancellable(TaskStatus.FAILED)).toBe(
        false,
      );
    });
  });

  describe('transition', () => {
    it('mutates status on a valid transition', () => {
      const t = task(TaskStatus.CREATED);
      TransportTaskStateMachine.transition(t, TaskStatus.READY_TO_ASSIGN);
      expect(t.status).toBe(TaskStatus.READY_TO_ASSIGN);
    });

    it('drives the full happy path CREATED → DELIVERY_COMPLETED', () => {
      const t = task(TaskStatus.CREATED);
      for (const next of [
        TaskStatus.READY_TO_ASSIGN,
        TaskStatus.PICKING_UP,
        TaskStatus.DELIVERING,
        TaskStatus.DELIVERY_COMPLETED,
      ]) {
        TransportTaskStateMachine.transition(t, next);
      }
      expect(t.status).toBe(TaskStatus.DELIVERY_COMPLETED);
    });

    it('throws and leaves status untouched on an invalid transition', () => {
      const t = task(TaskStatus.DELIVERY_COMPLETED);
      expect(() =>
        TransportTaskStateMachine.transition(t, TaskStatus.PICKING_UP),
      ).toThrow(InvalidTransportTaskTransitionError);
      expect(t.status).toBe(TaskStatus.DELIVERY_COMPLETED);
    });

    it('rejects skipping a state (READY_TO_ASSIGN → DELIVERING)', () => {
      const t = task(TaskStatus.READY_TO_ASSIGN);
      expect(() =>
        TransportTaskStateMachine.transition(t, TaskStatus.DELIVERING),
      ).toThrow(InvalidTransportTaskTransitionError);
    });
  });

  describe('direct (non-cargo) tasks', () => {
    for (const kind of [TaskKind.MANUAL, TaskKind.PARK, TaskKind.CHARGE]) {
      for (const from of ALL_STATUSES) {
        for (const to of ALL_STATUSES) {
          const allowed = (DIRECT_VALID[from] ?? []).includes(to);
          it(`${kind}: ${allowed ? 'allows' : 'rejects'} ${from} → ${to}`, () => {
            expect(
              TransportTaskStateMachine.canTransition(from, to, kind),
            ).toBe(allowed);
          });
        }
      }
    }

    it('applies the task kind when transitioning an entity', () => {
      const direct = {
        status: TaskStatus.CREATED,
        kind: TaskKind.MANUAL,
      } as TransportTaskEntity;
      TransportTaskStateMachine.transition(direct, TaskStatus.EXECUTING);
      expect(direct.status).toBe(TaskStatus.EXECUTING);
      expect(() =>
        TransportTaskStateMachine.transition(
          {
            status: TaskStatus.CREATED,
            kind: TaskKind.CARGO,
          } as TransportTaskEntity,
          TaskStatus.EXECUTING,
        ),
      ).toThrow(InvalidTransportTaskTransitionError);
    });
  });
});
