import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One row per stay: a vehicle still carrying its cargo stopped on a cell that
 * the drop-off lanes exit through. Opened when the vehicle arrives on the cell,
 * closed with left_at/dwell_ms when it moves off, so a row with left_at NULL is
 * a vehicle sitting there right now. Written exclusively by
 * EgressOccupancyDetector; nothing reads it in the dispatch path.
 */
@Entity('egress_occupancy_events')
export class EgressOccupancyEventEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'vehicle_name', type: 'varchar', length: 50 })
  vehicleName!: string;

  @Column({ name: 'point_name', type: 'varchar', length: 50 })
  pointName!: string;

  /** 'lane exit' for a cell on a lane's way out, 'zone exit' for a way out of the zone. */
  @Column({ name: 'egress_kind', type: 'varchar', length: 20 })
  egressKind!: string;

  @Column({ name: 'lane_indexes', type: 'jsonb', default: () => `'[]'` })
  laneIndexes!: number[];

  @Column({ name: 'cells_out_of_lane', type: 'int', nullable: true })
  cellsOutOfLane!: number | null;

  @Column({ name: 'zone_id', type: 'uuid', nullable: true })
  zoneId!: string | null;

  @Column({ name: 'zone_name', type: 'varchar', length: 255, nullable: true })
  zoneName!: string | null;

  @Column({ name: 'task_id', type: 'uuid', nullable: true })
  taskId!: string | null;

  @Column({ name: 'request_code', type: 'varchar', length: 50, nullable: true })
  requestCode!: string | null;

  @Column({ name: 'cargo_id', type: 'uuid', nullable: true })
  cargoId!: string | null;

  @Column({ name: 'item_code', type: 'varchar', length: 255, nullable: true })
  itemCode!: string | null;

  @Column({
    name: 'transport_order_name',
    type: 'varchar',
    length: 120,
    nullable: true,
  })
  transportOrderName!: string | null;

  /** Everything else WES held at that moment: vehicle state, task, cargo, lanes, neighbours. */
  @Column({ type: 'jsonb', default: {} })
  snapshot!: Record<string, unknown>;

  @Column({ name: 'entered_at', type: 'timestamptz', default: () => 'now()' })
  enteredAt!: Date;

  @Column({ name: 'left_at', type: 'timestamptz', nullable: true })
  leftAt!: Date | null;

  @Column({ name: 'dwell_ms', type: 'bigint', nullable: true })
  dwellMs!: string | null;

  /** Kernel SSE timestamp of the update that placed the vehicle here. Diagnostics only. */
  @Column({ name: 'observed_at', type: 'timestamptz', nullable: true })
  observedAt!: Date | null;
}
