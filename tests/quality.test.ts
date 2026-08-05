import assert from 'node:assert/strict';
import test from 'node:test';
import { countWords, recommendPageMode } from '../nodes/shared/quality';

test('recognizes a scan page with no native text', () => {
	assert.equal(recommendPageMode('', 1), 'ocr');
});

test('recognizes a scan page with only a small footer', () => {
	assert.equal(recommendPageMode('Seite 4 von 4', 1), 'ocr');
});

test('keeps a text page with a full-page background image native', () => {
	assert.equal(recommendPageMode('Vertrag '.repeat(25), 1), 'native');
});

test('does not OCR a small logo or an empty page', () => {
	assert.equal(recommendPageMode('', 0.02), 'native');
	assert.equal(recommendPageMode('', 0), 'native');
});

test('rejects a broken native text layer', () => {
	assert.equal(recommendPageMode(`Vertragstext ${'�'.repeat(30)}`, 0), 'ocr');
});

test('counts German words, numbers and joined identifiers', () => {
	assert.equal(countWords('Zahlungsanforderung 26 BA22-01151 9.478.505,84'), 5);
});
