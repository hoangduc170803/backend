import { TaskStatus } from '../entities/transport-task.entity';

const DIED_HOLDING_THE_SLOT: readonly TaskStatus[] = [
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
];

export function willNeverDropThere(status: TaskStatus | null): boolean {
  return status === null || DIED_HOLDING_THE_SLOT.includes(status);
}
