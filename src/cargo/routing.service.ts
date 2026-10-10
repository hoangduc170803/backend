import { Injectable, Logger } from '@nestjs/common';
import { KernelApiService } from '../opentcs/kernel-api.service';
import type {
  KernelPath,
  KernelPlantModel,
} from '../opentcs/domain/kernel-model';
import { resolveLocationPoints } from '../zones/domain/member-points';
import {
  RoadEdge,
  RoadGraph,
  buildRoadGraph,
  reverseRoadGraph,
} from './domain/routing';

function toRoadEdge(path: KernelPath): RoadEdge {
  return {
    from: path.srcPointName,
    to: path.destPointName,
    length: path.length,
    maxVelocity: path.maxVelocity,
    maxReverseVelocity: path.maxReverseVelocity,
  };
}

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  private cachedModel: KernelPlantModel | null = null;
  private cachedGraph: RoadGraph | null = null;
  private cachedReverseGraph: RoadGraph | null = null;

  constructor(private readonly kernelApi: KernelApiService) {}

  async getRoadGraph(): Promise<RoadGraph | null> {
    const plantModel = await this.kernelApi.getPlantModelView();
    if (!plantModel) {
      this.logger.warn('getRoadGraph: plant model unavailable');
      return null;
    }
    const modelUnchangedSinceLastBuild = plantModel === this.cachedModel;
    if (modelUnchangedSinceLastBuild) return this.cachedGraph;

    this.cachedModel = plantModel;
    this.cachedGraph = this.build(plantModel);
    this.cachedReverseGraph = this.cachedGraph
      ? reverseRoadGraph(this.cachedGraph)
      : null;
    return this.cachedGraph;
  }

  async getReverseRoadGraph(): Promise<RoadGraph | null> {
    await this.getRoadGraph();
    return this.cachedReverseGraph;
  }

  async pointsOfLocations(
    locationNames: readonly string[],
  ): Promise<Map<string, string>> {
    if (locationNames.length === 0) return new Map();
    const plantModel = await this.kernelApi.getPlantModelView();
    if (!plantModel) {
      this.logger.warn('pointsOfLocations: plant model unavailable');
      return new Map();
    }
    return resolveLocationPoints(plantModel.locations, locationNames);
  }

  private build(plantModel: KernelPlantModel): RoadGraph | null {
    const edges = plantModel.paths
      .filter((path) => !path.locked)
      .map(toRoadEdge);

    if (edges.length === 0) {
      this.logger.warn('getRoadGraph: plant model has no usable paths');
      return null;
    }

    const graph = buildRoadGraph(edges);
    const oneWayPaths = edges.filter(
      (edge) => edge.maxVelocity <= 0 || edge.maxReverseVelocity <= 0,
    ).length;
    this.logger.log(
      `Road graph built: ${graph.size} point(s), ${edges.length} path(s), ${oneWayPaths} one-way`,
    );
    return graph;
  }
}
