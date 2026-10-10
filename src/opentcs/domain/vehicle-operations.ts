export type VehicleType = 'loopback' | 'vda5050';

export interface VehicleOperations {
  load: string;
  unload: string;
  charge: string;
}

const VEHICLE_OPERATIONS: Record<VehicleType, VehicleOperations> = {
  loopback: { load: 'PICK_UP', unload: 'DROP_OFF', charge: 'CHARGE' },
  vda5050: { load: 'liftUp', unload: 'liftDown', charge: 'startCharging' },
};

export function vehicleOperationsFor(vehicleType: string): VehicleOperations {
  if (vehicleType in VEHICLE_OPERATIONS) {
    return VEHICLE_OPERATIONS[vehicleType as VehicleType];
  }
  throw new Error(
    `VEHICLE_TYPE không hợp lệ: "${vehicleType}". Chỉ chấp nhận: ${Object.keys(VEHICLE_OPERATIONS).join(' | ')}.`,
  );
}
