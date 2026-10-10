import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DispatchPolicyEntity } from './entities/dispatch-policy.entity';
import { clampWeight } from './domain/dispatch-cost';

export interface ActiveDispatchWeights {
  readonly battery: number;
}

export interface DispatchPolicyView {
  id: string;
  name: string;
  weightBattery: number;
  maxAgvPerBlock: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DispatchPolicyInput {
  name?: string;
  weightBattery?: number;
}

@Injectable()
export class DispatchPolicyService {
  constructor(
    @InjectRepository(DispatchPolicyEntity)
    private readonly repo: Repository<DispatchPolicyEntity>,
  ) {}

  async getActiveWeights(): Promise<ActiveDispatchWeights | null> {
    const active = await this.repo.findOne({
      where: { isActive: true },
      order: { updatedAt: 'DESC' },
    });
    if (!active) return null;
    return { battery: clampWeight(active.weightBattery) };
  }

  async list(): Promise<DispatchPolicyView[]> {
    const rows = await this.repo.find({ order: { createdAt: 'ASC' } });
    return rows.map((row) => this.toView(row));
  }

  async create(
    input: DispatchPolicyInput & { name: string },
    createdBy: string | null,
  ): Promise<DispatchPolicyView> {
    const saved = await this.repo.save(
      this.repo.create({
        name: input.name,
        weightBattery: input.weightBattery ?? 0,
        isActive: false,
        createdBy,
      }),
    );
    return this.toView(saved);
  }

  async update(
    id: string,
    input: DispatchPolicyInput,
  ): Promise<DispatchPolicyView> {
    const policy = await this.findOrThrow(id);
    if (input.name !== undefined) policy.name = input.name;
    if (input.weightBattery !== undefined)
      policy.weightBattery = input.weightBattery;
    return this.toView(await this.repo.save(policy));
  }

  async activate(id: string): Promise<DispatchPolicyView> {
    await this.findOrThrow(id);
    await this.repo.manager.transaction(async (manager) => {
      await manager.update(
        DispatchPolicyEntity,
        { isActive: true },
        { isActive: false },
      );
      await manager.update(DispatchPolicyEntity, { id }, { isActive: true });
    });
    return this.toView(await this.findOrThrow(id));
  }

  async deactivate(id: string): Promise<DispatchPolicyView> {
    const policy = await this.findOrThrow(id);
    policy.isActive = false;
    return this.toView(await this.repo.save(policy));
  }

  private async findOrThrow(id: string): Promise<DispatchPolicyEntity> {
    const policy = await this.repo.findOne({ where: { id } });
    if (!policy) throw new NotFoundException(`Dispatch policy ${id} not found`);
    return policy;
  }

  private toView(row: DispatchPolicyEntity): DispatchPolicyView {
    return {
      id: row.id,
      name: row.name,
      weightBattery: row.weightBattery,
      maxAgvPerBlock: row.maxAgvPerBlock,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
