import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A role with zero rows here is unrestricted (identical to today's behavior for every existing
 * role). Only once an admin explicitly assigns one or more map records does a role become scoped
 * to just those — see PLAN §5 AUTH-3 and `createAppAbility`'s `mapIds` contract in `auth/ability.ts`.
 */
export class AddRoleMapScopes1815000000000 implements MigrationInterface {
  name = 'AddRoleMapScopes1815000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS role_map_scopes (
        role_id smallint NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
        map_record_id uuid NOT NULL REFERENCES map_records (id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (role_id, map_record_id)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS role_map_scopes`);
  }
}
