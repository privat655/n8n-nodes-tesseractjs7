import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUsableNativeText } from '../nodes/shared/quality';

const body = 'Vertrag '.repeat(60);

test('accepts documents with short title pages and real body pages', () => {
	assert.equal(hasUsableNativeText(['Vertrag', body, body, 'Unterschriften']), true);
});

test('rejects documents that contain only headers and page numbers', () => {
	assert.equal(hasUsableNativeText(['Vertrag 1', 'Vertrag 2', 'Vertrag 3', 'Vertrag 4']), false);
});

test('accepts numeric tables as meaningful native text', () => {
	assert.equal(hasUsableNativeText(['2026 1000 2000 3000 '.repeat(25)]), true);
});

test('rejects broken unicode text layers', () => {
	assert.equal(hasUsableNativeText([`${body}${'�'.repeat(100)}`]), false);
});
