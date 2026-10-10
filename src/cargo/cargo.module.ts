import { MapRecordCoreModule } from '../maps/map-record-core.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CargoEntity } from './entities/cargo.entity';
import { TransportTaskEntity } from './entities/transport-task.entity';
import { TaskStatusTransitionEntity } from './entities/task-status-transition.entity';
import { EgressOccupancyEventEntity } from './entities/egress-occupancy-event.entity';
import { DispatchPolicyEntity } from './entities/dispatch-policy.entity';
import { ZoneEntity } from '../zones/entities/zone.entity';
import { AgvEntity } from '../agvs/entities/agv.entity';
import { CargoService } from './cargo.service';
import { CargoController } from './cargo.controller';
import { DispatchPolicyService } from './dispatch-policy.service';
import { DispatchPolicyController } from './dispatch-policy.controller';
import { TransportTaskService } from './transport-task.service';
import { TaskTerminationService } from './task-termination.service';
import { ReleaseEngineService } from './release-engine.service';
import { AssignmentEngineService } from './assignment-engine.service';
import { ChargeEngineService } from './charge-engine.service';
import { ChargeRecallService } from './charge-recall.service';
import { ChargeSlotReservationStore } from './charge-slot-reservation.store';
import { WorkEnergyGuard } from './work-energy.guard';
import { OrphanOrderSweeper } from './orphan-order.sweeper';
import { DestinationCapacityGate } from './destination-capacity.gate';
import { ParkingEngineService } from './parking-engine.service';
import { ParkClaimStore } from './park-claim.store';
import { LegReconcileService } from './leg-reconcile.service';
import { TransportTaskSaga } from './transport-task.saga';
import { DispatchSchedulerService } from './dispatch-scheduler.service';
import { DeliverySlotEngine } from './delivery-slot.engine';
import { SlotReservationService } from './slot-reservation.service';
import { SlotReclaimService } from './slot-reclaim.service';
import { DropoffOrderService } from './dropoff-order.service';
import { VehicleAimService } from './vehicle-aim.service';
import { DropoffCommitLoop } from './dropoff-commit.loop';
import { EgressOccupancyDetector } from './egress-occupancy.detector';
import { ZoneGeometryService } from './zone-geometry.service';
import { PickupDependencyService } from './pickup-dependency.service';
import { LaneSafetyService } from './lane-safety.service';
import { RoutingService } from './routing.service';
import { RetreatPointService } from './retreat-point.service';
import { ApproachOrderService } from './approach-order.service';
import { DispatchDistanceService } from './dispatch-distance.service';
import { VehicleCandidateService } from './vehicle-candidate.service';
import { PickupOrderService } from './pickup-order.service';
import { OpenTcsModule } from '../opentcs/opentcs.module';
import { EnvironmentalEntityModule } from '../environmental-entities/environmental-entity.module';
import { KernelSessionModule } from '../kernel-session/kernel-session.module';
import { KernelOrderReplayService } from './kernel-order-replay.service';
import { TaskOrderEntity } from './entities/task-order.entity';
import { TaskOrderService } from './task-order.service';
import { TaskOrderReconcileService } from './task-order-reconcile.service';
import { ParkYieldService } from './park-yield.service';
import { DirectTaskService } from './direct-task.service';
import { DirectTaskSaga } from './direct-task.saga';
import { LoadHandlingGuard } from './load-handling.guard';
import { TaskCancellationService } from './task-cancellation.service';
import { OrderReplacementService } from './order-replacement.service';
import { OrderRecreationService } from './order-recreation.service';
import { VehicleDisconnectWatcher } from './vehicle-disconnect.watcher';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CargoEntity,
      TransportTaskEntity,
      TaskStatusTransitionEntity,
      EgressOccupancyEventEntity,
      DispatchPolicyEntity,
      ZoneEntity,
      AgvEntity,
      TaskOrderEntity,
    ]),
    OpenTcsModule,
    MapRecordCoreModule,
    EnvironmentalEntityModule,
    KernelSessionModule,
  ],
  providers: [
    CargoService,
    TransportTaskService,
    TaskTerminationService,
    DeliverySlotEngine,
    SlotReservationService,
    SlotReclaimService,
    DropoffOrderService,
    VehicleAimService,
    DropoffCommitLoop,
    EgressOccupancyDetector,
    ZoneGeometryService,
    PickupDependencyService,
    LaneSafetyService,
    RoutingService,
    DispatchPolicyService,
    RetreatPointService,
    ApproachOrderService,
    ParkClaimStore,
    DispatchDistanceService,
    VehicleCandidateService,
    PickupOrderService,
    ReleaseEngineService,
    AssignmentEngineService,
    ChargeEngineService,
    ChargeRecallService,
    ChargeSlotReservationStore,
    WorkEnergyGuard,
    OrphanOrderSweeper,
    DestinationCapacityGate,
    ParkingEngineService,
    LegReconcileService,
    DispatchSchedulerService,
    TransportTaskSaga,
    TaskOrderService,
    TaskOrderReconcileService,
    ParkYieldService,
    DirectTaskService,
    DirectTaskSaga,
    LoadHandlingGuard,
    TaskCancellationService,
    OrderReplacementService,
    OrderRecreationService,
    VehicleDisconnectWatcher,
    KernelOrderReplayService,
  ],
  controllers: [CargoController, DispatchPolicyController],
  exports: [
    DeliverySlotEngine,
    CargoService,
    TaskOrderService,
    DirectTaskService,
    TaskCancellationService,
    OrderReplacementService,
    VehicleDisconnectWatcher,
  ],
})
export class CargoModule {}
