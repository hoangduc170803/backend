import {
  TaskOrderState,
  type TaskOrderLeg,
} from '../entities/task-order.entity';
import { currentLegOrder } from './current-leg-order';

const order = (
  seq: number,
  leg: TaskOrderLeg,
  state: TaskOrderState,
  vehicleName = 'V1',
) => ({ seq, leg, state, orderName: `${leg}-${seq}`, vehicleName });

describe('currentLegOrder', () => {
  it('finds nothing on a task without orders', () => {
    expect(currentLegOrder([], 'PICKUP')).toBeNull();
  });

  it('takes the newest order of the leg', () => {
    const orders = [
      order(1, 'PICKUP', TaskOrderState.FINISHED),
      order(2, 'APPROACH', TaskOrderState.ACTIVE),
    ];

    expect(currentLegOrder(orders, 'APPROACH')?.orderName).toBe('APPROACH-2');
    expect(currentLegOrder(orders, 'DROPOFF')).toBeNull();
  });

  it('keeps an order the kernel ended, so a missed outcome can still be replayed', () => {
    const orders = [order(1, 'PICKUP', TaskOrderState.FINISHED)];

    expect(currentLegOrder(orders, 'PICKUP')?.orderName).toBe('PICKUP-1');
  });

  it.each([
    TaskOrderState.WITHDRAWING,
    TaskOrderState.WITHDRAWN,
    TaskOrderState.REPLACED,
    TaskOrderState.PREEMPTED,
  ])('skips an order WES set aside itself (%s)', (state) => {
    const orders = [
      order(1, 'PICKUP', TaskOrderState.FINISHED),
      order(2, 'DROPOFF', state),
      order(3, 'APPROACH', TaskOrderState.ACTIVE),
    ];

    expect(currentLegOrder(orders, 'DROPOFF')).toBeNull();
    expect(currentLegOrder(orders, 'APPROACH')?.orderName).toBe('APPROACH-3');
  });

  it('follows a replaced order to its successor', () => {
    const orders = [
      order(1, 'PICKUP', TaskOrderState.REPLACED),
      order(2, 'PICKUP', TaskOrderState.ACTIVE, 'V2'),
    ];

    expect(currentLegOrder(orders, 'PICKUP')).toMatchObject({
      orderName: 'PICKUP-2',
      vehicleName: 'V2',
    });
  });

  it('ignores the drop-off of an earlier attempt once the task is picked up again', () => {
    const orders = [
      order(1, 'PICKUP', TaskOrderState.FINISHED),
      order(2, 'DROPOFF', TaskOrderState.FAILED),
      order(3, 'PICKUP', TaskOrderState.ACTIVE),
    ];

    expect(currentLegOrder(orders, 'DROPOFF')).toBeNull();
    expect(currentLegOrder(orders, 'PICKUP')?.orderName).toBe('PICKUP-3');
  });
});
