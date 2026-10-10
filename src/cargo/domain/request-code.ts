import { TaskKind } from '../entities/transport-task.entity';

const PREFIX: Readonly<Record<TaskKind, string>> = {
  [TaskKind.CARGO]: 'TR',
  [TaskKind.MANUAL]: 'MN',
  [TaskKind.PARK]: 'PK',
  [TaskKind.CHARGE]: 'CH',
};

export function newRequestCode(kind: TaskKind, now = Date.now()): string {
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${PREFIX[kind]}-${now}-${suffix}`;
}
