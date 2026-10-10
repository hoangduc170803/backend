import { solveHungarian } from './hungarian';

function bruteForceMinimum(matrix: readonly (readonly number[])[]): number {
  const targetMatches = Math.min(matrix.length, matrix[0]?.length ?? 0);

  const search = (
    row: number,
    usedColumns: ReadonlySet<number>,
    matched: number,
  ): number => {
    if (row === matrix.length) {
      return matched === targetMatches ? 0 : Infinity;
    }

    let best = Infinity;
    const rowsRemaining = matrix.length - row - 1;
    if (matched + rowsRemaining >= targetMatches) {
      best = search(row + 1, usedColumns, matched);
    }
    for (let column = 0; column < matrix[row].length; column++) {
      if (usedColumns.has(column)) continue;
      const nextUsed = new Set(usedColumns);
      nextUsed.add(column);
      best = Math.min(
        best,
        matrix[row][column] + search(row + 1, nextUsed, matched + 1),
      );
    }
    return best;
  };

  return search(0, new Set(), 0);
}

describe('solveHungarian', () => {
  it('finds the minimum-cost assignment for a square matrix', () => {
    const result = solveHungarian([
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ]);

    expect(result).toEqual({ assignment: [1, 0, 2], totalCost: 5 });
  });

  it('supports more columns than rows', () => {
    const result = solveHungarian([
      [4, 1, 3, 2],
      [2, 0, 5, 3],
    ]);

    expect(result).toEqual({ assignment: [3, 1], totalCost: 2 });
  });

  it('supports more rows than columns and marks surplus rows unmatched', () => {
    const result = solveHungarian([
      [10, 1],
      [1, 10],
      [2, 2],
    ]);

    expect(result).toEqual({ assignment: [1, 0, -1], totalCost: 2 });
  });

  it('supports negative costs without mutating the input', () => {
    const matrix = [
      [-1, -2],
      [-3, -1],
    ];
    const snapshot = matrix.map((row) => [...row]);

    expect(solveHungarian(matrix)).toEqual({
      assignment: [1, 0],
      totalCost: -5,
    });
    expect(matrix).toEqual(snapshot);
  });

  it('is deterministic when multiple assignments have the same cost', () => {
    expect(
      solveHungarian([
        [0, 0],
        [0, 0],
      ]).assignment,
    ).toEqual([0, 1]);
  });

  it('handles empty dimensions', () => {
    expect(solveHungarian([])).toEqual({ assignment: [], totalCost: 0 });
    expect(solveHungarian([[], []])).toEqual({
      assignment: [-1, -1],
      totalCost: 0,
    });
  });

  it('rejects ragged or non-finite matrices', () => {
    expect(() => solveHungarian([[1, 2], [3]])).toThrow('rectangular');
    expect(() => solveHungarian([[1, Infinity]])).toThrow('must be finite');
    expect(() => solveHungarian([[Number.NaN]])).toThrow('must be finite');
  });

  it('matches a brute-force oracle for small rectangular matrices', () => {
    for (let rows = 1; rows <= 4; rows++) {
      for (let columns = 1; columns <= 4; columns++) {
        const matrix = Array.from({ length: rows }, (_, row) =>
          Array.from(
            { length: columns },
            (_, column) => (((row + 3) * 17 + (column + 5) * 11) % 23) - 11,
          ),
        );

        const result = solveHungarian(matrix);
        expect(result.totalCost).toBe(bruteForceMinimum(matrix));
        expect(result.assignment.filter((column) => column >= 0)).toHaveLength(
          Math.min(rows, columns),
        );
        expect(
          new Set(result.assignment.filter((column) => column >= 0)).size,
        ).toBe(Math.min(rows, columns));
      }
    }
  });
});
