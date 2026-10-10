import { CargoStatus } from '../entities/cargo.entity';
import { laneIndexOfTarget, type ZoneSlotLayout } from './zone-slot-layout';
import type { ColumnClaims } from './column-queue';

export interface ZoneClaim {
  readonly id: string;
  readonly status: CargoStatus;
  readonly destinationLocationName: string | null;
  readonly reservedLocationName: string | null;
}

export class ZoneOccupancy<T extends ZoneClaim = ZoneClaim> {
  private constructor(
    private readonly claims: readonly T[],
    private readonly layout: ZoneSlotLayout,
  ) {}

  static of<T extends ZoneClaim>(
    claims: readonly T[],
    layout: ZoneSlotLayout,
  ): ZoneOccupancy<T> {
    return new ZoneOccupancy(claims, layout);
  }

  committedSlots(): Set<string> {
    const slots = new Set<string>();
    for (const claim of this.claims) {
      if (claim.destinationLocationName) {
        slots.add(claim.destinationLocationName);
      }
    }
    return slots;
  }

  slotsHoldingAPallet(): Set<string> {
    const slots = new Set<string>();
    for (const claim of this.claims) {
      if (
        claim.status === CargoStatus.DELIVERED &&
        claim.destinationLocationName
      ) {
        slots.add(claim.destinationLocationName);
      }
    }
    return slots;
  }

  columnClaims(): ColumnClaims {
    const committed = new Set<string>();
    const reserved = new Set<string>();
    for (const claim of this.claims) {
      if (claim.reservedLocationName) reserved.add(claim.reservedLocationName);
      if (
        claim.status === CargoStatus.ACTIVE &&
        claim.destinationLocationName
      ) {
        committed.add(claim.destinationLocationName);
      }
    }
    return {
      finished: this.slotsHoldingAPallet(),
      committed,
      reserved,
    };
  }

  claimedTargets(): Set<string> {
    const targets = this.committedSlots();
    for (const claim of this.claims) {
      if (claim.reservedLocationName) targets.add(claim.reservedLocationName);
    }
    return targets;
  }

  activeCountByLane(): number[] {
    const counts = new Array<number>(this.layout.lanes.length).fill(0);
    for (const target of this.claimedCells()) {
      const lane = laneIndexOfTarget(this.layout, target);
      if (lane !== null) counts[lane]++;
    }
    return counts;
  }

  private claimedCells(): Set<string> {
    const cells = new Set<string>();
    for (const claim of this.claims) {
      const target =
        claim.destinationLocationName ?? claim.reservedLocationName;
      if (target) cells.add(target);
    }
    return cells;
  }

  committedInLane(laneIndex: number): string | null {
    return (
      this.liveCommits().find(
        (slot) => laneIndexOfTarget(this.layout, slot) === laneIndex,
      ) ?? null
    );
  }

  holderOf(target: string, excluding: ZoneClaim): T | null {
    return (
      this.claims.find(
        (claim) =>
          claim.id !== excluding.id &&
          claim.reservedLocationName === target &&
          !claim.destinationLocationName,
      ) ?? null
    );
  }

  private liveCommits(): string[] {
    const slots: string[] = [];
    for (const claim of this.claims) {
      if (claim.status !== CargoStatus.ACTIVE) continue;
      if (claim.destinationLocationName) {
        slots.push(claim.destinationLocationName);
      }
    }
    return slots;
  }
}
