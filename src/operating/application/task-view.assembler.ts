import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { TransportTaskEntity } from '../../cargo/entities/transport-task.entity';
import { CargoEntity } from '../../cargo/entities/cargo.entity';
import { TaskStatusTransitionEntity } from '../../cargo/entities/task-status-transition.entity';
import { ZoneEntity } from '../../zones/entities/zone.entity';
import type { TaskOrderEntity } from '../../cargo/entities/task-order.entity';
import { TaskOrderService } from '../../cargo/task-order.service';
import { TERMINAL_TASK_STATUSES, toTaskDto } from '../domain/task-view';
import type { TaskDto } from '../dto/operating.dto';

@Injectable()
export class TaskViewAssembler {
  constructor(
    @InjectRepository(CargoEntity)
    private readonly cargoRepo: Repository<CargoEntity>,
    @InjectRepository(ZoneEntity)
    private readonly zoneRepo: Repository<ZoneEntity>,
    @InjectRepository(TaskStatusTransitionEntity)
    private readonly transitionRepo: Repository<TaskStatusTransitionEntity>,
    private readonly taskOrders: TaskOrderService,
  ) {}

  async assemble(tasks: readonly TransportTaskEntity[]): Promise<TaskDto[]> {
    const cargoById = await this.cargosOf(tasks);
    const zoneNameById = await this.zoneNamesOf([...cargoById.values()]);
    const failureReasonByTask = await this.failureReasonsOf(tasks);
    const ordersByTask = await this.ordersOf(tasks);

    return tasks.map((task) => {
      const cargo = task.cargoId ? (cargoById.get(task.cargoId) ?? null) : null;
      return toTaskDto(task, {
        cargo,
        destinationZoneName: cargo?.destinationZoneId
          ? (zoneNameById.get(cargo.destinationZoneId) ?? null)
          : null,
        failureReason: failureReasonByTask.get(task.id) ?? null,
        orders: ordersByTask.get(task.id) ?? [],
      });
    });
  }

  private async ordersOf(
    tasks: readonly TransportTaskEntity[],
  ): Promise<Map<string, TaskOrderEntity[]>> {
    const byTask = new Map<string, TaskOrderEntity[]>();
    for (const order of await this.taskOrders.ordersOf(
      tasks.map((task) => task.id),
    )) {
      const orders = byTask.get(order.taskId);
      if (orders) orders.push(order);
      else byTask.set(order.taskId, [order]);
    }
    return byTask;
  }

  private async cargosOf(
    tasks: readonly TransportTaskEntity[],
  ): Promise<Map<string, CargoEntity>> {
    const ids = tasks.flatMap((task) => (task.cargoId ? [task.cargoId] : []));
    if (ids.length === 0) return new Map();
    const cargos = await this.cargoRepo.find({
      where: { id: In(ids) },
      withDeleted: true,
    });
    return new Map(cargos.map((cargo) => [cargo.id, cargo]));
  }

  private async zoneNamesOf(
    cargos: readonly CargoEntity[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        cargos.flatMap((cargo) =>
          cargo.destinationZoneId ? [cargo.destinationZoneId] : [],
        ),
      ),
    ];
    if (ids.length === 0) return new Map();
    const zones = await this.zoneRepo.find({ where: { id: In(ids) } });
    return new Map(zones.map((zone) => [zone.id, zone.name]));
  }

  private async failureReasonsOf(
    tasks: readonly TransportTaskEntity[],
  ): Promise<Map<string, string>> {
    const terminalIds = tasks
      .filter((task) => TERMINAL_TASK_STATUSES.includes(task.status))
      .map((task) => task.id);
    if (terminalIds.length === 0) return new Map();

    const transitions = await this.transitionRepo.find({
      where: {
        taskId: In(terminalIds),
        toStatus: In([...TERMINAL_TASK_STATUSES]),
      },
      order: { occurredAt: 'DESC' },
    });
    const reasons = new Map<string, string>();
    for (const transition of transitions) {
      if (transition.reason && !reasons.has(transition.taskId)) {
        reasons.set(transition.taskId, transition.reason);
      }
    }
    return reasons;
  }
}
