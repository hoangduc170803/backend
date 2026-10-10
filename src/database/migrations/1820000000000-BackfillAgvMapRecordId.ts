import { MigrationInterface, QueryRunner } from 'typeorm';

interface AgvRow {
  id: string;
  name: string;
  plant_model_name: string;
}

interface RecordCandidate {
  id: string;
  last_loaded_at: Date | null;
}

/**
 * Same matching rule as `1814000000000-BackfillZoneMapRecordId` (`resolveBackfillMatch` in
 * `src/zones/domain/map-record-backfill.ts`), inlined rather than imported: a migration's
 * behaviour must stay fixed at the moment it ran, even if that helper's logic changes later.
 */
function resolveMatch(candidates: RecordCandidate[]): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].id;
  const everLoaded = candidates.filter((c) => c.last_loaded_at !== null);
  if (everLoaded.length === 0) return null;
  const [latest] = [...everLoaded].sort(
    (a, b) => b.last_loaded_at!.getTime() - a.last_loaded_at!.getTime(),
  );
  if (
    everLoaded.filter(
      (c) => c.last_loaded_at!.getTime() === latest.last_loaded_at!.getTime(),
    ).length !== 1
  )
    return null;
  return latest.id;
}

/**
 * One-time backfill of `agvs.map_record_id` from the pre-existing `plant_model_name` string.
 * Only resolves an AGV when its name maps to exactly one `map_records` row, or to exactly one
 * *most-recently-loaded* row among several same-named ones (see `resolveMatch`). Everything else
 * is left NULL and printed below for manual follow-up — a wrong guess would silently misattribute
 * the AGV to the wrong map.
 */
export class BackfillAgvMapRecordId1820000000000
  implements MigrationInterface
{
  name = 'BackfillAgvMapRecordId1820000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const agvs = (await queryRunner.query(
      `SELECT id, name, plant_model_name FROM agvs
       WHERE map_record_id IS NULL AND plant_model_name IS NOT NULL`,
    )) as AgvRow[];
    if (agvs.length === 0) {
      console.log('BackfillAgvMapRecordId: no AGV needs backfilling.');
      return;
    }

    const byMapName = new Map<string, AgvRow[]>();
    for (const agv of agvs) {
      const list = byMapName.get(agv.plant_model_name) ?? [];
      list.push(agv);
      byMapName.set(agv.plant_model_name, list);
    }

    let resolvedCount = 0;
    const unresolved: { mapName: string; agvNames: string[] }[] = [];

    for (const [mapName, agvsForName] of byMapName) {
      const candidates = (await queryRunner.query(
        `SELECT id, last_loaded_at FROM map_records WHERE name = $1`,
        [mapName],
      )) as RecordCandidate[];
      const matchId = resolveMatch(candidates);

      if (matchId) {
        await queryRunner.query(
          `UPDATE agvs SET map_record_id = $1 WHERE id = ANY($2::uuid[])`,
          [matchId, agvsForName.map((a) => a.id)],
        );
        resolvedCount += agvsForName.length;
      } else {
        unresolved.push({
          mapName,
          agvNames: agvsForName.map((a) => a.name),
        });
      }
    }

    console.log(
      `BackfillAgvMapRecordId: resolved ${resolvedCount} AGV(s) across ${byMapName.size - unresolved.length} map name(s).`,
    );
    if (unresolved.length > 0) {
      console.warn(
        `BackfillAgvMapRecordId: ${unresolved.length} map name(s) left unresolved — multiple` +
          ' candidate records with no unique "most recently loaded" one. Review and assign manually:',
      );
      for (const { mapName, agvNames } of unresolved) {
        console.warn(`  - "${mapName}": AGV(s) ${agvNames.join(', ')}`);
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Backfill is a best-effort data repair, not a schema change — reverting it would throw away
    // a manual re-run's chance to redo the same (idempotent) matching, so this is a no-op.
    await queryRunner.query('SELECT 1');
  }
}
