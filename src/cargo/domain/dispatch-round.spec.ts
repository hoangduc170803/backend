import { counterfactualMatcher, planDispatchRound } from './dispatch-round';
import type {
  DispatchTaskCandidate,
  VehicleCandidate,
} from './dispatch.policy';

function vehicle(
  name: string,
  currentPosition: string,
  overrides: Partial<VehicleCandidate> = {},
): VehicleCandidate {
  return {
    name,
    dispatchEnabled: true,
    ignored: false,
    available: true,
    preemptibleParking: false,
    energyLevel: 80,
    criticalThreshold: 20,
    currentPosition,
    hasActiveTask: false,
    ...overrides,
  };
}

function task(
  taskId: string,
  distances: Record<string, number>,
): DispatchTaskCandidate {
  return {
    taskId,
    distanceByPoint: new Map(Object.entries(distances)),
    approachDistance: null,
  };
}

describe('counterfactualMatcher', () => {
  it('is always the matcher that did not run the fleet', () => {
    expect(counterfactualMatcher('hungarian')).toBe('greedy');
    expect(counterfactualMatcher('greedy')).toBe('hungarian');
  });
});

describe('planDispatchRound', () => {
  const candidates = [vehicle('V1', 'P1'), vehicle('V2', 'P2')];
  const tasks = [task('t1', { P1: 10, P2: 1 }), task('t2', { P1: 20, P2: 30 })];

  it('dispatches the hungarian plan and files greedy as the counterfactual', () => {
    const round = planDispatchRound(candidates, tasks, 0, 'hungarian');

    expect(round.matcher).toBe('hungarian');
    expect(round.assignments).not.toBe(round.counterfactual);
    expect(round.assignments.map((a) => a.taskId).sort()).toEqual(['t1', 't2']);
  });

  it('swaps which plan is real when the fleet runs greedy', () => {
    const hungarianRound = planDispatchRound(candidates, tasks, 0, 'hungarian');
    const greedyRound = planDispatchRound(candidates, tasks, 0, 'greedy');

    expect(greedyRound.matcher).toBe('greedy');
    expect(greedyRound.assignments).toEqual(hungarianRound.counterfactual);
    expect(greedyRound.counterfactual).toEqual(hungarianRound.assignments);
  });

  it('indexes the counterfactual by task, so a task reads its own alternative', () => {
    const round = planDispatchRound(candidates, tasks, 0, 'hungarian');

    for (const alternative of round.counterfactual) {
      expect(round.counterfactualByTask.get(alternative.taskId)).toBe(
        alternative,
      );
    }
    expect(round.counterfactualByTask.size).toBe(round.counterfactual.length);
  });

  it('reports no assignment at all when every vehicle is busy', () => {
    const busy = candidates.map((c) => ({ ...c, hasActiveTask: true }));

    const round = planDispatchRound(busy, tasks, 0, 'hungarian');

    expect(round.assignments).toEqual([]);
    expect(round.counterfactual).toEqual([]);
    expect(round.counterfactualByTask.size).toBe(0);
  });

  it('leaves a task unplanned when there are fewer vehicles than tasks', () => {
    const round = planDispatchRound(
      [vehicle('V1', 'P1')],
      tasks,
      0,
      'hungarian',
    );

    expect(round.assignments).toHaveLength(1);
  });
});
