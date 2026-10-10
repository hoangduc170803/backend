import { willNeverDropThere } from './slot-reclaim.policy';
import { TaskStatus } from '../entities/transport-task.entity';

describe('willNeverDropThere', () => {
  it('is true for a task that failed holding the slot', () => {
    expect(willNeverDropThere(TaskStatus.FAILED)).toBe(true);
  });

  it('is true for a task that was cancelled', () => {
    expect(willNeverDropThere(TaskStatus.CANCELLED)).toBe(true);
  });

  it('is true when the commit outlived its task', () => {
    expect(willNeverDropThere(null)).toBe(true);
  });

  it('is false while the vehicle is still on its way', () => {
    expect(willNeverDropThere(TaskStatus.DELIVERING)).toBe(false);
  });

  it('is false for a delivery that already finished, which frees its own slot', () => {
    expect(willNeverDropThere(TaskStatus.DELIVERY_COMPLETED)).toBe(false);
  });

  it('is false for every state that still leads somewhere', () => {
    const stillGoing = [
      TaskStatus.CREATED,
      TaskStatus.READY_TO_ASSIGN,
      TaskStatus.BLOCKED,
      TaskStatus.PICKING_UP,
    ];

    expect(stillGoing.map(willNeverDropThere)).toEqual(
      stillGoing.map(() => false),
    );
  });
});
