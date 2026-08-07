import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { slicePdfBuffer, validatePageSlice } from '../nodes/shared/pdfSlice';

async function makePdf(pageCount: number): Promise<Buffer> {
	const pdf = await PDFDocument.create();
	for (let index = 0; index < pageCount; index++) {
		pdf.addPage([200 + index, 300 + index]);
	}
	return Buffer.from(await pdf.save());
}

async function loadPageSizes(buffer: Uint8Array): Promise<Array<[number, number]>> {
	const pdf = await PDFDocument.load(buffer);
	return pdf.getPages().map((page) => [page.getWidth(), page.getHeight()]);
}

test('slices an inclusive page range in original order', async () => {
	const source = await makePdf(10);
	const result = await slicePdfBuffer(source, 4, 10);
	assert.equal(result.pageCount, 10);
	assert.deepEqual(await loadPageSizes(result.bytes), [
		[203, 303],
		[204, 304],
		[205, 305],
		[206, 306],
		[207, 307],
		[208, 308],
		[209, 309],
	]);
});

test('slices the first pages', async () => {
	const source = await makePdf(10);
	const result = await slicePdfBuffer(source, 1, 3);
	assert.deepEqual(await loadPageSizes(result.bytes), [
		[200, 300],
		[201, 301],
		[202, 302],
	]);
});

test('slices a single page', async () => {
	const source = await makePdf(5);
	const result = await slicePdfBuffer(source, 3, 3);
	assert.deepEqual(await loadPageSizes(result.bytes), [[202, 302]]);
});

test('rejects invalid page bounds', () => {
	assert.throws(() => validatePageSlice(10, 0, 3), /Page From/);
	assert.throws(() => validatePageSlice(10, 4, 3), /greater than or equal/);
	assert.throws(() => validatePageSlice(10, 1, 11), /document page count/);
	assert.throws(() => validatePageSlice(10, 11, 11), /document page count/);
});

test('generated output is a standalone PDF with only selected pages', async () => {
	const source = await makePdf(6);
	const result = await slicePdfBuffer(source, 2, 4);
	const output = await PDFDocument.load(result.bytes);
	assert.equal(output.getPageCount(), 3);
	assert.ok(Buffer.from(result.bytes).subarray(0, 5).toString('ascii').startsWith('%PDF-'));
});
