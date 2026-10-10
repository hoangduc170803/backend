import {
  type DispatchMatcher,
  type DispatchTaskCandidate,
  type VehicleCandidate,
  type VehicleTaskAssignment,
  planVehicleAssignments,
  planVehicleAssignmentsGreedy,
} from './dispatch.policy';

export interface DispatchRound {
  readonly matcher: DispatchMatcher;
  readonly assignments: readonly VehicleTaskAssignment[];
  readonly counterfactual: readonly VehicleTaskAssignment[];
  readonly counterfactualByTask: ReadonlyMap<string, VehicleTaskAssignment>;
}

export function counterfactualMatcher(
  matcher: DispatchMatcher,
): DispatchMatcher {
  return matcher === 'greedy' ? 'hungarian' : 'greedy';
}

export function planDispatchRound(
  candidates: readonly VehicleCandidate[],
  tasks: readonly DispatchTaskCandidate[],
  batteryWeight: number,
  matcher: DispatchMatcher,
): DispatchRound {
  const hungarian = planVehicleAssignments(candidates, tasks, batteryWeight);
  const greedy = planVehicleAssignmentsGreedy(candidates, tasks, batteryWeight);
  const chosen = matcher === 'greedy' ? greedy : hungarian;
  const alternative = matcher === 'greedy' ? hungarian : greedy;

  return {
    matcher,
    assignments: chosen,
    counterfactual: alternative,
    counterfactualByTask: new Map(
      alternative.map((assignment) => [assignment.taskId, assignment]),
    ),
  };
}
