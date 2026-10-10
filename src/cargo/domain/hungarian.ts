export interface HungarianResult {
  readonly assignment: number[];
  readonly totalCost: number;
}

export function solveHungarian(
  costMatrix: readonly (readonly number[])[],
): HungarianResult {
  const rowCount = costMatrix.length;
  if (rowCount === 0) return { assignment: [], totalCost: 0 };

  const columnCount = costMatrix[0].length;
  validateCostMatrix(costMatrix, columnCount);
  if (columnCount === 0) {
    return { assignment: Array<number>(rowCount).fill(-1), totalCost: 0 };
  }

  if (rowCount <= columnCount) {
    return solveRows(costMatrix);
  }

  const transposed = Array.from({ length: columnCount }, (_, column) =>
    Array.from({ length: rowCount }, (_, row) => costMatrix[row][column]),
  );
  const transposedResult = solveRows(transposed);
  const assignment = Array<number>(rowCount).fill(-1);

  for (let originalColumn = 0; originalColumn < columnCount; originalColumn++) {
    const originalRow = transposedResult.assignment[originalColumn];
    if (originalRow >= 0) assignment[originalRow] = originalColumn;
  }

  return {
    assignment,
    totalCost: assignment.reduce(
      (sum, column, row) => (column >= 0 ? sum + costMatrix[row][column] : sum),
      0,
    ),
  };
}

function validateCostMatrix(
  costMatrix: readonly (readonly number[])[],
  columnCount: number,
): void {
  for (let row = 0; row < costMatrix.length; row++) {
    if (costMatrix[row].length !== columnCount) {
      throw new TypeError('Hungarian cost matrix must be rectangular');
    }
    for (let column = 0; column < columnCount; column++) {
      if (!Number.isFinite(costMatrix[row][column])) {
        throw new TypeError(
          `Hungarian cost at row ${row}, column ${column} must be finite`,
        );
      }
    }
  }
}

function solveRows(
  costMatrix: readonly (readonly number[])[],
): HungarianResult {
  const rowCount = costMatrix.length;
  const columnCount = costMatrix[0].length;

  const u = Array<number>(rowCount + 1).fill(0);
  const v = Array<number>(columnCount + 1).fill(0);
  const p = Array<number>(columnCount + 1).fill(0);
  const way = Array<number>(columnCount + 1).fill(0);

  for (let row = 1; row <= rowCount; row++) {
    p[0] = row;
    let currentColumn = 0;
    const minSlack = Array<number>(columnCount + 1).fill(Infinity);
    const used = Array<boolean>(columnCount + 1).fill(false);

    do {
      used[currentColumn] = true;
      const currentRow = p[currentColumn];
      let delta = Infinity;
      let nextColumn = 0;

      for (let column = 1; column <= columnCount; column++) {
        if (used[column]) continue;
        const reducedCost =
          costMatrix[currentRow - 1][column - 1] - u[currentRow] - v[column];
        if (reducedCost < minSlack[column]) {
          minSlack[column] = reducedCost;
          way[column] = currentColumn;
        }
        if (
          minSlack[column] < delta ||
          (minSlack[column] === delta &&
            (nextColumn === 0 || column < nextColumn))
        ) {
          delta = minSlack[column];
          nextColumn = column;
        }
      }

      for (let column = 0; column <= columnCount; column++) {
        if (used[column]) {
          u[p[column]] += delta;
          v[column] -= delta;
        } else {
          minSlack[column] -= delta;
        }
      }
      currentColumn = nextColumn;
    } while (p[currentColumn] !== 0);

    do {
      const previousColumn = way[currentColumn];
      p[currentColumn] = p[previousColumn];
      currentColumn = previousColumn;
    } while (currentColumn !== 0);
  }

  const assignment = Array<number>(rowCount).fill(-1);
  for (let column = 1; column <= columnCount; column++) {
    if (p[column] !== 0) assignment[p[column] - 1] = column - 1;
  }

  return {
    assignment,
    totalCost: assignment.reduce(
      (sum, column, row) => sum + costMatrix[row][column],
      0,
    ),
  };
}
