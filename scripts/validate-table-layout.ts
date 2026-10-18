import assert from 'node:assert/strict';
import { getArticleTableWidth, getTableCellContentWidth, getTableColumnCount } from '../src/utils/tableLayout';

const cell = (tagName: 'td' | 'th', colspan?: string) => ({
  tagName,
  attributes: colspan ? { colspan } : {},
});
const row = (...children: ReturnType<typeof cell>[]) => ({ tagName: 'tr', children });

const twoColumnTable = {
  tagName: 'table',
  children: [{ tagName: 'tbody', children: [row(cell('td'), cell('td'))] }],
};
assert.equal(getTableColumnCount(twoColumnTable), 2);
assert.equal(getArticleTableWidth(twoColumnTable, 360, 96), 358);

const wideTable = {
  tagName: 'table',
  children: [row(cell('th'), cell('th', '2'), cell('th'))],
};
assert.equal(getTableColumnCount(wideTable), 4);
assert.equal(getArticleTableWidth(wideTable, 360, 96), 384);
assert.equal(getArticleTableWidth(wideTable, 360, 180), 720);
assert.equal(getTableCellContentWidth(wideTable, wideTable.children[0].children[0], 360, 180, 12), 154);
assert.equal(getTableCellContentWidth(wideTable, wideTable.children[0].children[1], 360, 180, 12), 334);

const nestedTable = {
  tagName: 'table',
  children: [
    row(cell('td'), cell('td')),
    { tagName: 'table', children: [row(cell('td'), cell('td'), cell('td'))] },
  ],
};
assert.equal(getTableColumnCount(nestedTable), 2);

console.log('Table layout validation passed.');
