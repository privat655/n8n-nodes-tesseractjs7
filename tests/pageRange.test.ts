import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePageRange } from '../nodes/shared/pdf';

test('resolves the complete document when Page To is zero', () => {
	assert.deepEqual(resolvePageRange(4, 1, 0), [1, 2, 3, 4]);
});

test('resolves an inclusive page range', () => {
	assert.deepEqual(resolvePageRange(30, 10, 13), [10, 11, 12, 13]);
});

test('rejects ranges outside the document', () => {
	assert.throws(() => resolvePageRange(5, 1, 6), /page count/);
	assert.throws(() => resolvePageRange(5, 4, 3), /greater than or equal/);
});
