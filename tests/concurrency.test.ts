import assert from 'node:assert/strict';
import test from 'node:test';
import { mapLimit } from '../nodes/shared/concurrency';

test('runs one job at a time and preserves order', async () => {
	let active = 0;
	let maximum = 0;
	const values = [1, 2, 3, 4, 5, 6];
	const result = await mapLimit(values, 1, async (value) => {
		active++;
		maximum = Math.max(maximum, active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active--;
		return value * 2;
	});

	assert.equal(maximum, 1);
	assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
});
