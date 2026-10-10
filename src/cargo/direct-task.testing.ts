import type { TransportOrderService } from '../opentcs/transport-order.service';
import type { TransportTaskEntity } from './entities/transport-task.entity';
import type {
  DirectTaskRequest,
  DirectTaskService,
} from './direct-task.service';

export function directTasksIssuingThrough(
  transportOrders: TransportOrderService,
): DirectTaskService {
  return {
    create: async (request: DirectTaskRequest) => ({
      task: {} as TransportTaskEntity,
      orderName: await transportOrders.issue({
        kind: request.kind,
        vehicleName: request.vehicleName,
        aimedAt: request.aimedAt,
        destinations: request.destinations,
        dispensable: request.dispensable,
        type: request.type,
      }),
    }),
  } as unknown as DirectTaskService;
}
