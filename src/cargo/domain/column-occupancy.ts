export interface ColumnVehicle {
  readonly name: string;
  readonly currentPosition: string | null;
  readonly transportOrder?: string | null;
  readonly procState: string;
}

export interface ColumnLane {
  readonly axisPoints: readonly string[];
}

export function columnUpToMainline(
  slotPointNames: readonly string[],
  behindPointNames: readonly string[],
  mainlinePoints: ReadonlySet<string>,
): string[] {
  const column = [...slotPointNames];
  for (const pointName of behindPointNames) {
    column.push(pointName);
    if (mainlinePoints.has(pointName)) break;
  }
  return column;
}

export function standsWithoutAnOrder(vehicle: ColumnVehicle): boolean {
  if (vehicle.transportOrder) return false;
  return vehicle.procState === 'IDLE' || vehicle.procState === 'AWAITING_ORDER';
}

export function vehicleParkedInColumn(
  vehicles: readonly ColumnVehicle[],
  columnPoints: ReadonlySet<string>,
  requesterVehicleName: string | null,
): ColumnVehicle | null {
  return (
    vehicles.find(
      (vehicle) =>
        vehicle.name !== requesterVehicleName &&
        vehicle.currentPosition !== null &&
        columnPoints.has(vehicle.currentPosition) &&
        standsWithoutAnOrder(vehicle),
    ) ?? null
  );
}

export function vehicleAheadInLane(
  vehicles: readonly ColumnVehicle[],
  lane: ColumnLane,
  requesterVehicleName: string | null,
  requesterPosition: string | null,
): ColumnVehicle | null {
  const requesterIndex =
    requesterPosition === null
      ? -1
      : lane.axisPoints.indexOf(requesterPosition);

  return (
    vehicles.find((vehicle) => {
      if (
        vehicle.name === requesterVehicleName ||
        vehicle.currentPosition === null
      ) {
        return false;
      }

      const vehicleIndex = lane.axisPoints.indexOf(vehicle.currentPosition);
      if (vehicleIndex === -1) return false;
      return requesterIndex === -1 || vehicleIndex < requesterIndex;
    }) ?? null
  );
}
