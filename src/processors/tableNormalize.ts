export function normalizeTables(clone: HTMLElement) {
  const allTables = clone.querySelectorAll('table');
  allTables.forEach((table) => {
    const rows = Array.from((table as HTMLTableElement).rows);
    if (rows.length === 0) return;
    const grid: (HTMLElement | null)[][] = [];
    for (let r = 0; r < rows.length; r++) {
      if (!grid[r]) grid[r] = [];
      const row = rows[r];
      const cells = Array.from(row.cells);
      let cIndex = 0;
      let cellIndex = 0;
      while (cellIndex < cells.length) {
        while (grid[r][cIndex]) cIndex++;
        const cell = cells[cellIndex];
        const rs = parseInt(cell.getAttribute('rowspan') || '1', 10);
        const cs = parseInt(cell.getAttribute('colspan') || '1', 10);
        const newCell = cell.cloneNode(true) as HTMLElement;
        newCell.removeAttribute('rowspan');
        newCell.removeAttribute('colspan');
        grid[r][cIndex] = newCell;
        for (let i = 0; i < rs; i++) {
          for (let j = 0; j < cs; j++) {
            if (i === 0 && j === 0) continue;
            if (!grid[r + i]) grid[r + i] = [];
            const empty = document.createElement(cell.tagName);
            empty.innerHTML = '&nbsp;';
            grid[r + i][cIndex + j] = empty;
          }
        }
        cIndex += cs;
        cellIndex++;
      }
    }
    const newTbody = document.createElement('tbody');
    grid.forEach((gridRow) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < gridRow.length; c++) {
        let cell = gridRow[c];
        if (!cell) {
          cell = document.createElement('td');
          cell.innerHTML = '&nbsp;';
        }
        tr.appendChild(cell);
      }
      newTbody.appendChild(tr);
    });
    table.innerHTML = '';
    table.appendChild(newTbody);
  });
}

