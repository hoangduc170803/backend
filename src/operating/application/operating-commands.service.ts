import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AxiosError } from 'axios';
import { KernelApiService } from '../../opentcs/kernel-api.service';
import { VehicleStateStore } from '../../opentcs/vehicle-state.store';
import type { KernelVehicleState } from '../../opentcs/domain/kernel-model';
import type { CreateManualOrderDto } from '../dto/operating.dto';
import { OperatingPlantModelService } from './operating-plant-model.service';
import { resolveOrderDestination } from '../domain/order-destination';
import { TransportOrderService } from '../../opentcs/transport-order.service';
import { ORDER_KIND } from '../../opentcs/domain/transport-order';
import { TaskKind } from '../../cargo/entities/transport-task.entity';
import { DirectTaskService } from '../../cargo/direct-task.service';
import {
  TaskCancellationService,
  type CancelPermissions,
} from '../../cargo/task-cancellation.service';
import {
  OrderReplacementService,
  type OrderWithdrawalResult,
} from '../../cargo/order-replacement.service';
import { VehicleDisconnectWatcher } from '../../cargo/vehicle-disconnect.watcher';
import type { TaskCancelResultDto } from '../../cargo/cargo.dto';

const INTEGRATION_LEVELS = new Set([
  'TO_BE_IGNORED',
  'TO_BE_NOTICED',
  'TO_BE_RESPECTED',
  'TO_BE_UTILIZED',
] as const);

type IntegrationLevel =
  typeof INTEGRATION_LEVELS extends Set<infer T> ? T : never;

const POINT_OPERATIONS = new Set(['MOVE']);

function isEmergencyStopped(vehicle: KernelVehicleState | undefined): boolean {
  return (
    vehicle?.errors?.fatal.some(
      (errorType) => errorType.toLowerCase() === 'estop',
    ) ?? false
  );
}

/** Turn a kernel 4xx into a clean 400 carrying the kernel's own message. */
function rethrowKernel(err: unknown, hint?: string): never {
  if (err instanceof AxiosError && err.response && err.response.status < 500) {
    const data = err.response.data as { message?: string } | string | undefined;
    const raw =
      typeof data === 'string'
        ? data.trim()
        : typeof data?.message === 'string'
          ? data.message
          : '';
    const msg = raw || err.message;
    throw new BadRequestException(
      hint
        ? `Hệ thống điều khiển từ chối (${msg}). ${hint}`
        : `Hệ thống điều khiển từ chối: ${msg}`,
    );
  }
  throw err;
}

/**
 * Write-side kernel controls for the operating screen — the same calls an operator would
 * otherwise curl by hand (integration level, pause, comm-adapter, order withdrawal, path lock,
 * manual transport order) plus a fleet-wide pause/resume. No cargo/zone business logic here.
 */
@Injectable()
export class OperatingCommandsService {
  private readonly logger = new Logger(OperatingCommandsService.name);

  constructor(
    private readonly kernelApi: KernelApiService,
    private readonly vehicleStateStore: VehicleStateStore,
    private readonly plantModel: OperatingPlantModelService,
    private readonly transportOrders: TransportOrderService,
    private readonly directTasks: DirectTaskService,
    private readonly cancellation: TaskCancellationService,
    private readonly orderReplacement: OrderReplacementService,
    private readonly disconnectWatcher: VehicleDisconnectWatcher,
  ) {}

  /**
   * The operator only ever picks a point and an action — never a kernel Location name (see
   * `resolveOrderDestination`). Resolved here, once per order, from the live plant model, so
   * every caller of `createOrder` (the manual-order dialog, and anything else that reaches it)
   * gets the same point-only contract without duplicating the lookup.
   */
  async createOrder(dto: CreateManualOrderDto): Promise<{
    ok: true;
    name: string | null;
    queued: boolean;
    taskId: string;
    requestCode: string;
  }> {
    const requested = (dto.destinations ?? []).filter(
      (destination) => destination.name,
    );
    if (requested.length === 0) {
      throw new BadRequestException('Cần ít nhất 1 điểm đến.');
    }

    const [locations, locationTypes] = await Promise.all([
      this.plantModel.locations(),
      this.plantModel.locationTypes(),
    ]);

    const destinations = requested.map((destination) => {
      const operation = destination.operation || 'MOVE';
      const locationName = resolveOrderDestination(
        destination.name,
        operation,
        locations,
        locationTypes,
      );
      if (!locationName) {
        throw new BadRequestException(
          operation === 'NOP'
            ? `Điểm "${destination.name}" không gắn với Location nào — NOP cần một Location; dùng MOVE để chỉ di chuyển tới điểm.`
            : `Điểm "${destination.name}" không có Location nào hỗ trợ operation "${operation}".`,
        );
      }
      return { locationName, operation };
    });

    try {
      const { task, orderName } = await this.directTasks.create({
        kind: TaskKind.MANUAL,
        vehicleName: dto.intendedVehicle || null,
        aimedAt: destinations[destinations.length - 1].locationName,
        destinations,
        type: dto.type && dto.type !== '-' ? dto.type : undefined,
        trigger: 'API',
      });
      return {
        ok: true,
        name: orderName,
        queued: orderName === null,
        taskId: task.id,
        requestCode: task.requestCode,
      };
    } catch (err) {
      rethrowKernel(err);
    }
  }

  async withdrawOrder(
    name: string,
  ): Promise<{ ok: true } & OrderWithdrawalResult> {
    try {
      const result = await this.orderReplacement.withdrawFromOrdersTab(name);
      return { ok: true, ...result };
    } catch (err) {
      rethrowKernel(err);
    }
  }

  async setIntegrationLevel(
    name: string,
    value: string,
  ): Promise<{ ok: true }> {
    if (!INTEGRATION_LEVELS.has(value as IntegrationLevel)) {
      throw new BadRequestException(`Mức tích hợp không hợp lệ: ${value}`);
    }
    await this.kernelApi.setVehicleIntegrationLevel(
      name,
      value as IntegrationLevel,
    );
    return { ok: true };
  }

  async setPaused(name: string, paused: boolean): Promise<{ ok: true }> {
    if (isEmergencyStopped(this.vehicleStateStore.get(name))) {
      throw new BadRequestException(
        `Xe ${name} đang dừng khẩn cấp; không thể thao tác chạy/tạm dừng từ WES.`,
      );
    }
    await this.kernelApi.setVehiclePaused(name, paused);
    const current = this.vehicleStateStore.get(name);
    if (current && current.paused !== paused) {
      this.vehicleStateStore.set(name, {
        ...current,
        paused,
        observedAt: new Date().toISOString(),
      });
    }
    return { ok: true };
  }

  /**
   * A VDA5050 instant action — sent straight to the vehicle's comm adapter over MQTT, bypassing
   * the transport-order/route system entirely (unlike `startCharging`, which only ever happens
   * as part of a routed order to a Charging-type Location). Takes effect regardless of whatever
   * order/route state the vehicle is currently in.
   */
  async stopCharging(name: string): Promise<{ ok: true }> {
    await this.kernelApi.sendInstantAction(name, 'stopCharging');
    return { ok: true };
  }

  /**
   * Disconnecting a vehicle hands it back to the kernel cleanly: withdraw whatever order it's
   * running (so resources/reservations release properly) and set it TO_BE_IGNORED before the
   * comm adapter actually goes down — never leave the kernel still planning around a vehicle
   * wes can no longer talk to.
   */
  async setCommAdapter(name: string, enabled: boolean): Promise<{ ok: true }> {
    if (!enabled) {
      await this.disconnectWatcher.releaseVehicleWork(
        name,
        `Ngắt kết nối xe ${name}`,
        'API',
      );
      await this.kernelApi.setVehicleIntegrationLevel(name, 'TO_BE_IGNORED');
    }
    await this.kernelApi.setVehicleAdapterEnabled(name, enabled);
    return { ok: true };
  }

  async withdrawVehicle(
    name: string,
    permissions: CancelPermissions,
  ): Promise<{ ok: true; result: TaskCancelResultDto | null }> {
    const result = await this.cancellation.cancelVehicleWork(name, {
      permissions,
    });
    if (result?.outcome === 'failed') {
      throw new BadRequestException(result.reason);
    }
    return { ok: true, result };
  }

  async sendToPoint(
    name: string,
    point: string,
    operation: string,
  ): Promise<{ ok: true; name: string }> {
    if (!point) throw new BadRequestException('Thiếu điểm đến.');
    const op = operation || 'MOVE';
    if (!POINT_OPERATIONS.has(op)) {
      throw new BadRequestException(
        `Điểm đến là 1 point — operation phải là MOVE.`,
      );
    }
    try {
      const orderName = await this.transportOrders.issue({
        kind: ORDER_KIND.MOVE,
        vehicleName: name,
        aimedAt: point,
        destinations: [{ locationName: point, operation: op }],
      });
      return { ok: true, name: orderName };
    } catch (err) {
      rethrowKernel(err, 'Điểm đến phải là 1 point (operation MOVE).');
    }
  }

  async setPathLocked(name: string, locked: boolean): Promise<{ ok: true }> {
    try {
      await this.kernelApi.setPathLocked(name, locked);
    } catch (err) {
      rethrowKernel(err);
    }
    return { ok: true };
  }

  /**
   * Fleet-wide controls:
   *  - `stop-all` / `run-all` — the least destructive reading of "stop"/"run": pause (or
   *    unpause) every vehicle without touching orders or connectivity. `run-all` also lifts
   *    the integration level to TO_BE_UTILIZED so a vehicle that was only being respected can
   *    take work again.
   *  - `connect-all` — the counterpart to disconnecting a vehicle (which sets it
   *    TO_BE_IGNORED): re-enable every vehicle's comm adapter and bring it back to
   *    TO_BE_UTILIZED, same as reconnecting each one by hand.
   */
  async fleet(action: 'run-all' | 'stop-all' | 'connect-all'): Promise<{
    ok: boolean;
    applied: string[];
    failed: { name: string; reason: string }[];
  }> {
    let vehicles: KernelVehicleState[];
    try {
      vehicles = await this.kernelApi.getVehicles();
    } catch (err) {
      // A total failure to even list vehicles is not "0 vehicles, all succeeded" — the operator
      // needs to know nothing was attempted, not see a blanket success toast.
      throw new ServiceUnavailableException(
        `Không lấy được danh sách xe từ hệ thống điều khiển: ${(err as Error).message}`,
      );
    }

    const results = await Promise.allSettled(
      vehicles.map(async (vehicle) => {
        if (action === 'connect-all') {
          await this.kernelApi.setVehicleAdapterEnabled(vehicle.name, true);
          await this.kernelApi.setVehicleIntegrationLevel(
            vehicle.name,
            'TO_BE_UTILIZED',
          );
          return vehicle.name;
        }
        if (isEmergencyStopped(vehicle)) {
          throw new Error(
            `Xe ${vehicle.name} đang dừng khẩn cấp; không thể thao tác chạy/tạm dừng từ WES.`,
          );
        }
        await this.kernelApi.setVehiclePaused(
          vehicle.name,
          action === 'stop-all',
        );
        if (action === 'run-all') {
          await this.kernelApi.setVehicleIntegrationLevel(
            vehicle.name,
            'TO_BE_UTILIZED',
          );
        }
        return vehicle.name;
      }),
    );

    const applied: string[] = [];
    const failed: { name: string; reason: string }[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        applied.push(result.value);
      } else {
        failed.push({
          name: vehicles[index].name,
          reason:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    });

    this.logger.log(
      `Fleet ${action}: ${applied.length} applied, ${failed.length} failed`,
    );
    return { ok: failed.length === 0, applied, failed };
  }
}
