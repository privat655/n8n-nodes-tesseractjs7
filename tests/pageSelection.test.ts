import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPdfPages } from '../nodes/shared/pageSelection';

test('empty and wildcard select every physical page', () => {
	for (const value of ['', ' ', '*', ' * ']) assert.deepEqual(selectPdfPages(3, value), [1, 2, 3]);
});
test('selects mixed ranges, sorts, and deduplicates overlaps', () => {
	assert.deepEqual(selectPdfPages(15, '15, 3 - 5,1,3-4'), [1, 3, 4, 5, 15]);
	assert.deepEqual(selectPdfPages(5, '1-3,3-5', 5), [1, 2, 3, 4, 5]);
});
test('rejects invalid selections instead of falling back to all pages', () => {
	for (const value of ['0', '-1', '2-1', '1.5', '1,,2', '1,', '*,1', '1-', '1-2-3', 'x', '9007199254740992']) {
		assert.throws(() => selectPdfPages(10, value), value);
	}
	assert.throws(() => selectPdfPages(10, '11'));
	assert.throws(() => selectPdfPages(10, '1-11'));
});
test('checks limits before expanding even a very large range', () => {
	assert.throws(() => selectPdfPages(1000000000, '1-1000000000', 100), /Max Pages/);
	assert.throws(() => selectPdfPages(101, '', 100), /Max Pages/);
	assert.throws(() => selectPdfPages(0, '*'));
	assert.throws(() => selectPdfPages(1, '*', 0));
});
