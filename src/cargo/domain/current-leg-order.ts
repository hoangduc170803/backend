import {
  TaskOrderState,
  type TaskOrderEntity,
  type TaskOrderLeg,
} from '../entities/task-order.entity';

type LedgerRow = Pick<
  TaskOrderEntity,
  'leg' | 'seq' | 'state' | 'orderName' | 'vehicleName'
>;

const SET_ASIDE_BY_WES: ReadonlySet<TaskOrderState> = new Set([
  TaskOrderState.WITHDRAWING,
  TaskOrderState.WITHDRAWN,
  TaskOrderState.REPLACED,
  TaskOrderState.PREEMPTED,
]);

function currentAttemptStart(orders: readonly LedgerRow[]): number {
  return orders
    .filter((order) => order.leg === 'PICKUP')
    .reduce((latest, order) => Math.max(latest, order.seq), 0);
}

export function currentLegOrder<T extends LedgerRow>(
  orders: readonly T[],
  leg: TaskOrderLeg,
): T | null {
  const attemptStart = currentAttemptStart(orders);
  return orders
    .filter(
      (order) =>
        order.leg === leg &&
        order.seq >= attemptStart &&
        !SET_ASIDE_BY_WES.has(order.state),
    )
    .reduce<T | null>(
      (latest, order) => (!latest || order.seq > latest.seq ? order : latest),
      null,
    );
}
