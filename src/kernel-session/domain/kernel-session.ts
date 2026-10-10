export enum KernelSessionPhase {
  OFFLINE = 'OFFLINE',
  RESTORING = 'RESTORING',
  READY = 'READY',
}

export interface KernelSessionSnapshot {
  phase: KernelSessionPhase;
  step: string | null;
  stepIndex: number;
  stepCount: number;
  reason: string | null;
  lastError: string | null;
  epoch: string | null;
  since: string;
}

export interface KernelRestoreContext {
  readonly mapRecordId: string;
  readonly reason: string;
}

export interface KernelRestoreStep {
  readonly name: string;
  readonly order: number;
  run(context: KernelRestoreContext): Promise<void>;
}

export interface KernelProbe {
  reachable: boolean;
  operating: boolean;
  epoch: string | null;
}

export interface SessionMemory {
  phase: KernelSessionPhase;
  epoch: string | null;
  writesInFlight: number;
  pendingReason: string | null;
}

export type SessionDecision =
  | { kind: 'OFFLINE' }
  | { kind: 'WAIT'; step: string }
  | { kind: 'READY'; epoch: string }
  | { kind: 'RESTORE'; reason: string };

export const WAIT_PLANT_MODEL_WRITE = 'Đang ghi bản đồ xuống kernel';
export const WAIT_KERNEL_OPERATING = 'Chờ kernel chuyển sang chế độ vận hành';

export function decideSession(
  probe: KernelProbe,
  memory: SessionMemory,
): SessionDecision {
  if (memory.writesInFlight > 0) {
    return { kind: 'WAIT', step: WAIT_PLANT_MODEL_WRITE };
  }
  if (!probe.reachable) return { kind: 'OFFLINE' };
  if (!probe.operating) return { kind: 'WAIT', step: WAIT_KERNEL_OPERATING };
  if (memory.pendingReason) {
    return { kind: 'RESTORE', reason: memory.pendingReason };
  }
  if (probe.epoch) return { kind: 'READY', epoch: probe.epoch };
  return {
    kind: 'RESTORE',
    reason:
      memory.phase === KernelSessionPhase.OFFLINE
        ? 'Kernel vừa khởi động lại'
        : 'Kernel mất dữ liệu làm việc (nạp lại bản đồ hoặc khởi động lại)',
  };
}
