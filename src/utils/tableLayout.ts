export type TableLayoutNode = {
  tagName?: string | null;
  attributes?: Readonly<Record<string, string | undefined>>;
  children?: readonly TableLayoutNode[];
};

const normalizedTagName = (node: TableLayoutNode) => String(node.tagName ?? '').toLowerCase();

const cellColumnSpan = (node: TableLayoutNode) => {
  const value = Number.parseInt(String(node.attributes?.colspan ?? ''), 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
};

export const getTableColumnCount = (table: TableLayoutNode) => {
  let maximum = 1;

  const visit = (node: TableLayoutNode, root = false) => {
    const tagName = normalizedTagName(node);
    if (!root && tagName === 'table') return;
    if (tagName === 'tr') {
      const columns = (node.children ?? []).reduce((total, child) => {
        const childTagName = normalizedTagName(child);
        return childTagName === 'td' || childTagName === 'th' ? total + cellColumnSpan(child) : total;
      }, 0);
      maximum = Math.max(maximum, columns);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };

  visit(table, true);
  return maximum;
};

export const getArticleTableWidth = (table: TableLayoutNode, contentWidth: number, cellMinWidth: number) => (
  Math.max(1, contentWidth - 2, getTableColumnCount(table) * cellMinWidth)
);

export const getTableCellContentWidth = (
  table: TableLayoutNode,
  cell: TableLayoutNode,
  contentWidth: number,
  cellMinWidth: number,
  horizontalPadding: number,
) => {
  const columnCount = getTableColumnCount(table);
  const columnSpan = Math.min(cellColumnSpan(cell), columnCount);
  const tableWidth = getArticleTableWidth(table, contentWidth, cellMinWidth);
  const occupiedWidth = tableWidth * columnSpan / columnCount;
  return Math.max(1, Math.floor(occupiedWidth - horizontalPadding * 2 - 2));
};
