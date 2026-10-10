import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { KernelApiService } from './kernel-api.service';
import axios from 'axios';

@Injectable()
export class KernelSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(KernelSyncService.name);
  private readonly baseUrl: string;

  private static readonly POLL_INTERVAL_MS = 2_000;
  private static readonly MAX_ATTEMPTS = 30; // 60s total

  constructor(private readonly kernelApi: KernelApiService) {
    this.baseUrl = process.env.OPENTCS_KERNEL_URL ?? 'http://localhost:55200';
  }

  async onApplicationBootstrap(): Promise<void> {
    const reachable = await this.waitForKernel();
    if (!reachable) return;

    this.logger.log('Kernel sync complete — ready');

    const state = await this.kernelApi.getKernelState();
    if (state === 'OPERATING') {
      this.logger.log('Kernel already OPERATING — initializing vehicles');
      await this.kernelApi.initializeVehiclesForOperation();
    }
  }

  private async waitForKernel(): Promise<boolean> {
    const { MAX_ATTEMPTS, POLL_INTERVAL_MS } = KernelSyncService;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await axios.get(`${this.baseUrl}/v1/kernel/version`, {
          timeout: 3_000,
        });
        this.logger.log(`Kernel is reachable`);
        return true;
      } catch {
        if (attempt === MAX_ATTEMPTS) {
          this.logger.error(
            `Kernel not reachable after ${(MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s — skipping kernel sync`,
          );
          return false;
        }
        this.logger.log(`Waiting for kernel... (${attempt}/${MAX_ATTEMPTS})`);
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
    return false;
  }
}
