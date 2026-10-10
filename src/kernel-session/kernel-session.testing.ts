import type { KernelSessionService } from './kernel-session.service';
import type { KernelRestoreStep } from './domain/kernel-session';

export interface KernelSessionStub {
  ready: boolean;
  intact: boolean;
  steps: KernelRestoreStep[];
}

export function kernelSessionStub(
  initial: Partial<Omit<KernelSessionStub, 'steps'>> = {},
): KernelSessionService & { stub: KernelSessionStub } {
  const stub: KernelSessionStub = {
    ready: initial.ready ?? true,
    intact: initial.intact ?? true,
    steps: [],
  };
  return {
    stub,
    isReady: () => stub.ready,
    confirmIntact: () => Promise.resolve(stub.ready && stub.intact),
    registerStep: (step: KernelRestoreStep) => {
      stub.steps.push(step);
    },
  } as unknown as KernelSessionService & { stub: KernelSessionStub };
}
