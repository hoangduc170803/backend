import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runWithAdvisoryLock } from '../database/advisory-lock';

const SYNC_LOCK_KEY = 815_004_712;
const LOCK_WAIT_MS = 15_000;

export abstract class EntitySyncLock {
  abstract run(wait: boolean, work: () => Promise<void>): Promise<boolean>;
}

@Injectable()
export class PgAdvisoryEntitySyncLock extends EntitySyncLock {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  run(wait: boolean, work: () => Promise<void>): Promise<boolean> {
    return runWithAdvisoryLock(
      this.dataSource,
      SYNC_LOCK_KEY,
      wait ? LOCK_WAIT_MS : 0,
      work,
    );
  }
}
