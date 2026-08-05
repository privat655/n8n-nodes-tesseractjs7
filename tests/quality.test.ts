import assert from 'node:assert/strict';
import test from 'node:test';
import { countWords, recommendPageMode } from '../nodes/shared/quality';

test('OCRs pages without any valid character', () => {
	assert.equal(recommendPageMode('', 0), 'ocr');
	assert.equal(recommendPageMode(' \n\t\u0000', 0.02), 'ocr');
});

test('uses the relevant image rule for symbol-only pages', () => {
	assert.equal(recommendPageMode('---', 0.2), 'native');
	assert.equal(recommendPageMode('---', 0.201), 'ocr');
});

test('recognizes a scan page with only a small footer', () => {
	assert.equal(recommendPageMode('Seite 4 von 4', 1), 'ocr');
});

test('keeps a text page with a full-page background image native', () => {
	assert.equal(recommendPageMode('Vertrag '.repeat(25), 1), 'native');
});

test('keeps a short text page with a medium image native', () => {
	assert.equal(recommendPageMode('Hinweis', 0.5), 'native');
});

test('rejects a broken native text layer', () => {
	assert.equal(recommendPageMode(`${'Vertragstext '.repeat(2)}${'�'.repeat(30)}`, 0), 'ocr');
});

test('counts German words, numbers and joined identifiers', () => {
	assert.equal(countWords('Zahlungsanforderung 26 BA22-01151 9.478.505,84'), 5);
});
