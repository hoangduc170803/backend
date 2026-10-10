import { Injectable } from '@nestjs/common';
import { KernelApiService } from '../../opentcs/kernel-api.service';
import type {
  PlantModelLocationDto,
  PlantModelLocationTypeDto,
  PlantModelPathDto,
  PlantModelPointDto,
  PlantModelPointsDto,
} from '../dto/operating.dto';

interface RawPoint {
  name?: string;
  position?: { x?: number; y?: number };
  type?: string;
  vehicleOrientationAngle?: number | string;
  layout?: { labelOffset?: { x?: number; y?: number } };
}

interface RawLocation {
  name?: string;
  typeName?: string;
  type?: string;
  links?: { pointName?: string }[];
}

interface RawLocationType {
  name?: string;
  allowedOperations?: string[];
}

interface RawPath {
  name?: string;
  srcPointName?: string;
  destPointName?: string;
  locked?: boolean;
  maxVelocity?: number;
  maxReverseVelocity?: number;
  /** Path length in mm (openTCS model). */
  length?: number;
}

/**
 * Read-only projection of the kernel plant model for the operating screen. This is a FE
 * passthrough (ARCHITECTURE.md §5.2b) — no writes, no business logic. Logic ported verbatim
 * from the retired `wes-new` `PlantModelController`, validated against the live kernel there.
 */
@Injectable()
export class OperatingPlantModelService {
  constructor(private readonly kernelApi: KernelApiService) {}

  async points(): Promise<PlantModelPointsDto> {
    const model = (await this.kernelApi.getRawPlantModel()) as Record<
      string,
      unknown
    > | null;
    const points = ((model?.points as RawPoint[] | undefined) ?? []).filter(
      (point): point is RawPoint & { name: string } =>
        typeof point.name === 'string',
    );
    const locations = (model?.locations as RawLocation[] | undefined) ?? [];
    const locationTypes =
      (model?.locationTypes as RawLocationType[] | undefined) ?? [];

    const chargeTypeNames = new Set(
      locationTypes
        .filter((lt) =>
          (lt.allowedOperations ?? []).includes(this.kernelApi.chargeOperation),
        )
        .map((lt) => lt.name)
        .filter((n): n is string => typeof n === 'string'),
    );

    const linkedPointNames = new Set<string>();
    const chargePointNames = new Set<string>();
    for (const location of locations) {
      const typeName = location.typeName ?? location.type;
      const isChargeLocation =
        typeof typeName === 'string' && chargeTypeNames.has(typeName);
      for (const link of location.links ?? []) {
        if (!link.pointName) continue;
        linkedPointNames.add(link.pointName);
        if (isChargeLocation) chargePointNames.add(link.pointName);
      }
    }

    return {
      modelName: typeof model?.name === 'string' ? model.name : '',
      points: points.map((point) => {
        const angle = Number(point.vehicleOrientationAngle);
        return {
          name: point.name,
          x: point.position?.x ?? 0,
          y: point.position?.y ?? 0,
          linked: linkedPointNames.has(point.name),
          charge: chargePointNames.has(point.name),
          type: typeof point.type === 'string' ? point.type : 'HALT_POSITION',
          labelOffsetX: point.layout?.labelOffset?.x ?? 0,
          labelOffsetY: point.layout?.labelOffset?.y ?? 0,
          orientationAngle: Number.isFinite(angle) ? angle : null,
        } satisfies PlantModelPointDto;
      }),
    };
  }

  async paths(): Promise<PlantModelPathDto[]> {
    const model = (await this.kernelApi.getRawPlantModel()) as Record<
      string,
      unknown
    > | null;
    const paths = (model?.paths as RawPath[] | undefined) ?? [];
    return paths
      .filter(
        (
          path,
        ): path is RawPath & {
          name: string;
          srcPointName: string;
          destPointName: string;
        } =>
          typeof path.name === 'string' &&
          typeof path.srcPointName === 'string' &&
          typeof path.destPointName === 'string',
      )
      .map((path) => {
        const maxVelocity = path.maxVelocity ?? 0;
        const maxReverseVelocity = path.maxReverseVelocity ?? 0;
        return {
          name: path.name,
          source: path.srcPointName,
          target: path.destPointName,
          locked: path.locked ?? false,
          maxVelocity,
          maxReverseVelocity,
          length: path.length ?? 0,
          oneWay: maxReverseVelocity === 0 && maxVelocity > 0,
        } satisfies PlantModelPathDto;
      });
  }

  async locations(): Promise<PlantModelLocationDto[]> {
    const model = (await this.kernelApi.getRawPlantModel()) as Record<
      string,
      unknown
    > | null;
    const locations = (model?.locations as RawLocation[] | undefined) ?? [];
    return locations
      .filter(
        (location): location is RawLocation & { name: string } =>
          typeof location.name === 'string',
      )
      .map((location) => ({
        name: location.name,
        type: location.typeName ?? location.type ?? '',
        pointNames: (location.links ?? [])
          .map((link) => link.pointName)
          .filter((name): name is string => typeof name === 'string'),
      }));
  }

  async locationTypes(): Promise<PlantModelLocationTypeDto[]> {
    const model = (await this.kernelApi.getRawPlantModel()) as Record<
      string,
      unknown
    > | null;
    const types = (model?.locationTypes as RawLocationType[] | undefined) ?? [];
    return types
      .filter(
        (type): type is RawLocationType & { name: string } =>
          typeof type.name === 'string',
      )
      .map((type) => ({
        name: type.name,
        allowedOperations: Array.isArray(type.allowedOperations)
          ? type.allowedOperations
          : [],
      }));
  }
}
