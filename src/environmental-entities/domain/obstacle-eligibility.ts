import { CargoStatus } from '../../cargo/entities/cargo.entity';
import type { CargoEntity } from '../../cargo/entities/cargo.entity';

type ObstacleCargo = Pick<
  CargoEntity,
  'status' | 'deletedAt' | 'mapRecordId' | 'destinationLocationName'
>;

/**
 * Why a cargo must NOT be an obstacle on openTCS — `null` when it should be one.
 * The single rule shared by the reconcile loop and the operator's "reactivate" action:
 * delivered, not deleted, and pinned to a map (a mapless legacy cargo would otherwise be
 * placed on whichever map is loaded, at whatever location happens to share its name).
 */
export function obstacleIneligibility(
  cargo: ObstacleCargo | null,
): string | null {
  if (!cargo || cargo.deletedAt) return 'Hàng không còn tồn tại';
  if (cargo.status !== CargoStatus.DELIVERED) {
    return 'Hàng không còn ở trạng thái đã giao';
  }
  if (!cargo.mapRecordId) return 'Hàng không gắn bản đồ';
  if (!cargo.destinationLocationName) return 'Hàng không có vị trí giao';
  return null;
}
