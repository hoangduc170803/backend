import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { KernelApiService } from './kernel-api.service';
import {
  kernelHttpStatus,
  toTransportOrderException,
} from './transport-order-error';
import {
  buildOrderName,
  deterministicOrderUuid,
  orderProperties,
  type CancelTransportOrder,
  type IssueTransportOrder,
} from './domain/transport-order';
import {
  TASK_ORDER_EVENTS,
  TaskOrderIssuedEvent,
  TaskOrderWithdrawingEvent,
} from '../cargo/domain/events';

const TERMINAL_ORDER_STATES = new Set(['FINISHED', 'FAILED', 'UNROUTABLE']);

@Injectable()
export class TransportOrderService {
  private readonly logger = new Logger(TransportOrderService.name);

  constructor(
    private readonly kernelApi: KernelApiService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  async issue(order: IssueTransportOrder): Promise<string> {
    const orderName = await this.createNamedOrder(order);
    if (order.taskId) {
      await this.events?.emitAsync(
        TASK_ORDER_EVENTS.ISSUED,
        new TaskOrderIssuedEvent(
          order.taskId,
          orderName,
          order.kind,
          order.vehicleName,
          order.destinations,
        ),
      );
    }
    return orderName;
  }

  private async createNamedOrder(order: IssueTransportOrder): Promise<string> {
    const deterministic = !!order.idempotencyKey;
    const uuid = order.idempotencyKey
      ? deterministicOrderUuid(order.kind, order.idempotencyKey)
      : randomUUID();
    const orderName = buildOrderName(
      order.kind,
      order.vehicleName,
      order.aimedAt,
      uuid,
    );

    try {
      await this.createOrder(order, orderName);
      return orderName;
    } catch (err) {
      if (!deterministic || kernelHttpStatus(err) !== 409) {
        throw toTransportOrderException(err, orderName, 'tạo');
      }

      // 409 (ObjectExistsException) on a deterministic name is ambiguous: either our own
      // earlier attempt already reached the kernel and only the response was lost (a real
      // timeout — resume as if this call had succeeded), or a past, concluded attempt for this
      // same task/leg used the same name and is long since done (its outcome doesn't apply to
      // *this* attempt — mint a fresh name instead of either resurrecting or permanently
      // refusing to ever retry this task/leg again). Ask the kernel which case this is; if that
      // itself fails, we genuinely don't know — fail closed rather than guess.
      let state: string | null;
      try {
        state = await this.kernelApi.getTransportOrderStateStrict(orderName);
      } catch (stateErr) {
        throw toTransportOrderException(stateErr, orderName, 'tạo');
      }

      if (state && !TERMINAL_ORDER_STATES.has(state)) {
        this.logger.warn(
          `Order "${orderName}" already existed and is still ${state} — treating create as already done`,
        );
        return orderName;
      }

      this.logger.warn(
        `Order "${orderName}" already existed but is done (${state ?? 'gone'}) — minting a fresh name for this attempt`,
      );
      const freshName = buildOrderName(
        order.kind,
        order.vehicleName,
        order.aimedAt,
        randomUUID(),
      );
      try {
        await this.createOrder(order, freshName);
      } catch (retryErr) {
        throw toTransportOrderException(retryErr, freshName, 'tạo');
      }
      return freshName;
    }
  }

  private async createOrder(
    order: IssueTransportOrder,
    orderName: string,
  ): Promise<void> {
    await this.kernelApi.createTransportOrder(
      orderName,
      [...order.destinations],
      order.vehicleName,
      orderProperties(order.kind, order.taskId),
      { dispensable: !!order.dispensable, type: order.type },
    );
  }

  async cancel(
    orderName: string,
    options: CancelTransportOrder = {},
  ): Promise<void> {
    const withdrawal = new TaskOrderWithdrawingEvent(
      orderName,
      options.reason ?? null,
      options.replacedBy ?? null,
    );
    await this.events?.emitAsync(TASK_ORDER_EVENTS.WITHDRAWING, withdrawal);
    try {
      await this.kernelApi.withdrawTransportOrder(
        orderName,
        !!options.immediate,
      );
    } catch (err) {
      // 404 (ObjectUnknownException): the order is already gone — nothing left to withdraw,
      // not a failure.
      if (kernelHttpStatus(err) !== 404) {
        await this.events?.emitAsync(
          TASK_ORDER_EVENTS.WITHDRAW_REFUSED,
          withdrawal,
        );
        throw toTransportOrderException(err, orderName, 'hủy');
      }
    }
    await this.events?.emitAsync(TASK_ORDER_EVENTS.WITHDRAWN, withdrawal);
  }
}
