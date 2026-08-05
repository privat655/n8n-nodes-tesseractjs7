import assert from 'node:assert/strict';
import test from 'node:test';
import { imageCoverageFromOperators, unionArea } from '../nodes/shared/pdf';

const ops = {
	save: 10,
	restore: 11,
	transform: 12,
	paintFormXObjectBegin: 74,
	paintFormXObjectEnd: 75,
	paintImageXObject: 85,
	paintInlineImageXObject: 86,
	paintInlineImageXObjectGroup: 87,
	paintImageXObjectRepeat: 88,
};

test('does not double count overlapping rectangles', () => {
	assert.equal(unionArea([[0, 0, 100, 100], [0, 0, 100, 100]]), 10000);
	assert.equal(unionArea([[0, 0, 50, 100], [50, 0, 100, 100]]), 10000);
});

test('measures full-page and logo image coverage', () => {
	assert.equal(
		imageCoverageFromOperators(100, 100, { fnArray: [12, 85], argsArray: [[100, 0, 0, 100, 0, 0], []] }, ops),
		1,
	);
	assert.equal(
		imageCoverageFromOperators(100, 100, { fnArray: [12, 85], argsArray: [[20, 0, 0, 10, 0, 0], []] }, ops),
		0.02,
	);
});

test('clips images and respects save and restore', () => {
	const coverage = imageCoverageFromOperators(
		100,
		100,
		{
			fnArray: [10, 12, 85, 11, 12, 85],
			argsArray: [[], [200, 0, 0, 100, -100, 0], [], [], [50, 0, 0, 100, 50, 0], []],
		},
		ops,
	);
	assert.equal(coverage, 1);
});

test('handles repeated and grouped image placements', () => {
	const repeated = imageCoverageFromOperators(
		100,
		100,
		{ fnArray: [88], argsArray: [['image', 50, 100, [0, 0, 50, 0]]] },
		ops,
	);
	const grouped = imageCoverageFromOperators(
		100,
		100,
		{
			fnArray: [87],
			argsArray: [['image', [{ transform: [50, 0, 0, 100, 0, 0] }, { transform: [50, 0, 0, 100, 50, 0] }]]],
		},
		ops,
	);
	assert.equal(repeated, 1);
	assert.equal(grouped, 1);
});
