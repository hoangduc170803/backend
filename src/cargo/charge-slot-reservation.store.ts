import { Injectable } from '@nestjs/common';

export interface ChargeSlotReservation {
  readonly location: string;
  readonly point: string;
  readonly forVehicle: string;
  readonly donor: string;
  readonly since: number;
}

@Injectable()
export class ChargeSlotReservationStore {
  private readonly byVehicle = new Map<string, ChargeSlotReservation>();

  reserve(reservation: ChargeSlotReservation): void {
    this.byVehicle.set(reservation.forVehicle, reservation);
  }

  release(forVehicle: string): void {
    this.byVehicle.delete(forVehicle);
  }

  all(): ChargeSlotReservation[] {
    return [...this.byVehicle.values()];
  }

  isWaiting(vehicle: string): boolean {
    return this.byVehicle.has(vehicle);
  }

  donors(): Set<string> {
    return new Set(this.all().map((r) => r.donor));
  }

  reservedPoints(): Set<string> {
    return new Set(this.all().map((r) => r.point));
  }

  pendingByLocation(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const { location } of this.all()) {
      counts.set(location, (counts.get(location) ?? 0) + 1);
    }
    return counts;
  }
}
