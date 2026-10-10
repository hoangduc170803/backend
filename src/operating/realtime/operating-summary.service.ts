import { Injectable } from '@nestjs/common';
import { ActiveMapContext } from '../../maps/infrastructure/active-map-context.service';
import { EnvironmentalEntityAdminService } from '../../environmental-entities/environmental-entity-admin.service';
import { OperatingCargoService } from '../application/operating-cargo.service';
import { OperatingOrdersService } from '../application/operating-orders.service';
import { OperatingTasksService } from '../application/operating-tasks.service';
import type { OperatingSummaryDto } from './projection-event';

function sumOf(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export function emptySummary(
  orders: OperatingSummaryDto['orders'] = {
    active: 0,
    processing: 0,
    recentTerminal: 0,
  },
): OperatingSummaryDto {
  return {
    mapRecordId: null,
    orders,
    tasks: { byStatus: {}, total: 0 },
    cargos: { byStatus: {}, total: 0 },
    obstacles: { present: 0, synced: 0, problem: 0 },
  };
}

@Injectable()
export class OperatingSummaryService {
  constructor(
    private readonly orders: OperatingOrdersService,
    private readonly tasks: OperatingTasksService,
    private readonly cargo: OperatingCargoService,
    private readonly obstacles: EnvironmentalEntityAdminService,
    private readonly activeMap: ActiveMapContext,
  ) {}

  async compute(): Promise<OperatingSummaryDto> {
    const mapRecordId = await this.activeMap.id();
    const orders = this.orders.counts();
    if (!mapRecordId) return emptySummary(orders);

    const [taskCounts, cargoList, obstacles] = await Promise.all([
      this.tasks.statusCounts(mapRecordId),
      this.cargo.list({}, undefined),
      this.obstacles.summaryOf(mapRecordId),
    ]);
    const cargoCounts: Record<string, number> = {};
    for (const cargo of cargoList.cargos) {
      cargoCounts[cargo.status] = (cargoCounts[cargo.status] ?? 0) + 1;
    }
    return {
      mapRecordId,
      orders,
      tasks: { byStatus: taskCounts, total: sumOf(taskCounts) },
      cargos: { byStatus: cargoCounts, total: cargoList.total },
      obstacles,
    };
  }
}
