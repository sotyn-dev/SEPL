import { Children, Fragment, cloneElement, isValidElement } from 'react';

// Flatten only arrays/fragments, never execute child components or inspect the DOM.
// Existing row keys, event handlers, inputs and record IDs remain intact.
function elements(children, ancestry = '') {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement(child)) return [child];
    // Fragment-local keys repeat (e.g. every indent's summary is ".0").
    // Keep the full keyed ancestry when removing the fragment boundary.
    const key = `${ancestry}/${child.key}`;
    return child.type === Fragment
      ? elements(child.props.children, key)
      : [cloneElement(child, { key })];
  });
}

function cells(row) {
  return elements(row.props.children).filter(isValidElement);
}

function text(children) {
  return Children.toArray(children).map(child =>
    typeof child === 'string' || typeof child === 'number' ? String(child)
      : isValidElement(child) ? text(child.props.children) : ''
  ).join('');
}

function columnCount(rows) {
  const occupied = [];
  let count = 0;
  rows.forEach((row, y) => {
    let x = 0;
    cells(row).forEach(cell => {
      while (occupied[y]?.[x]) x++;
      const width = Math.max(1, Number(cell.props.colSpan) || 1);
      const height = Math.max(1, Number(cell.props.rowSpan) || 1);
      for (let dy = 0; dy < height; dy++) {
        occupied[y + dy] ||= [];
        for (let dx = 0; dx < width; dx++) occupied[y + dy][x + dx] = true;
      }
      x += width;
      count = Math.max(count, x);
    });
  });
  return count;
}

/** A normal table with a narrow, pagination-aware display sequence column.
 * Use data-serial-skip on totals/expanded details, or data-serial-number for
 * grouped rows whose sequence must not change when another group is expanded.
 */
export default function NumberedTable({ children, start = 1, className = '', ...props }) {
  const sections = elements(children);
  const header = sections.find(child => isValidElement(child) && child.type === 'thead');
  const headerRows = header ? elements(header.props.children).filter(child => isValidElement(child) && child.type === 'tr') : [];
  const existing = headerRows.some(row => cells(row).some(cell => /^(?:s\.?\s*no\.?|sr\.?\s*no\.?|sl\.?\s*no\.?|sr|sl|#)$/i.test(text(cell.props.children).trim())));
  if (!headerRows.length || existing) return <table {...props} className={className}>{children}</table>;

  const width = columnCount(headerRows);
  let next = Math.max(1, Number(start) || 1);
  const numberRows = (children, footer = false) => elements(children).map(row => {
    if (!isValidElement(row) || row.type !== 'tr') return row;
    const rowCells = cells(row);
    if (!rowCells.length) return row;
    const first = rowCells[0];
    const spans = Number(first.props.colSpan) || 1;
    const explicit = row.props['data-serial-number'];
    const fullWidth = rowCells.length === 1 && spans > 1;
    const skip = footer || row.props['data-serial-skip'] || (spans > 1 && explicit == null);
    if (fullWidth || (skip && spans > 1)) {
      return cloneElement(row, {}, [cloneElement(first, { colSpan: fullWidth ? width + 1 : spans + 1 }), ...rowCells.slice(1)]);
    }
    const serial = skip ? '' : explicit ?? next++;
    return cloneElement(row, {}, [<td key="serial-number" className="serial-number-cell">{serial}</td>, ...elements(row.props.children)]);
  });
  return <table {...props} className={`numbered-table ${className}`}>
    {sections.map(section => {
      if (!isValidElement(section)) return section;
      if (section.type === 'thead') return cloneElement(section, {}, headerRows.map((row, index) => index ? row : cloneElement(row, {}, [
        <th key="serial-number" scope="col" rowSpan={headerRows.length} className="serial-number-cell">S.No.</th>, ...elements(row.props.children),
      ])));
      if (section.type === 'tbody' || section.type === 'tfoot') return cloneElement(section, {}, numberRows(section.props.children, section.type === 'tfoot'));
      if (section.type === 'colgroup') return cloneElement(section, {}, [<col key="serial-number" style={{ width: '2.75rem' }} />, ...elements(section.props.children)]);
      return section;
    })}
  </table>;
}
