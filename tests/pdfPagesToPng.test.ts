import assert from 'node:assert/strict';
import test from 'node:test';
import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { PdfPagesToPng } from '../nodes/PdfPagesToPng/PdfPagesToPng.node';

function fixturePdf(count = 3): Buffer {
	const kids = Array.from({ length: count }, (_, index) => `${3 + index * 2} 0 R`).join(' ');
	const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`];
	for (let index = 0; index < count; index++) {
		const content = `0 0 1 rg ${10 + index} 10 25 35 re f`;
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 80] /Rotate ${index === 1 ? 90 : 0} /Contents ${4 + index * 2} 0 R >>`);
		objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
	}
	let value = '%PDF-1.4\n';
	const offsets = [0];
	for (let index = 0; index < objects.length; index++) {
		offsets.push(Buffer.byteLength(value));
		value += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(value);
	value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) value += `${String(offset).padStart(10, '0')} 00000 n \n`;
	value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(value);
}

function context(buffers = [fixturePdf()], params: Record<string, unknown> = {}, continueOnFail = false) {
	const saved: Array<{ bytes: Buffer; name: string; mime: string }> = [];
	const reads: Array<{ index: number; field: string }> = [];
	const field = String(params.inputDataFieldName ?? 'data');
	const items: INodeExecutionData[] = buffers.map((_, index) => ({
		json: { marker: `input-${index}`, query: 'Inspect this page' },
		binary: { [field]: { data: 'filesystem-placeholder-not-base64', id: `source-${index}`, fileName: `source-${index}.pdf`, mimeType: 'application/pdf' } },
	}));
	const ctx = {
		getInputData: () => items,
		getNodeParameter: (name: string, _index: number, fallback: unknown) => params[name] ?? fallback,
		getNode: () => ({ id: 'test', name: 'PNG Test', type: 'n8n-nodes-tesseractjs7.pdfPagesToPng', typeVersion: 1, position: [0, 0], parameters: {} }),
		continueOnFail: () => continueOnFail,
		helpers: {
			getBinaryDataBuffer: async (index: number, inputField: string) => {
				reads.push({ index, field: inputField });
				return buffers[index];
			},
			prepareBinaryData: async (bytes: Buffer, name: string, mime: string) => {
				saved.push({ bytes: Buffer.from(bytes), name, mime });
				return { data: 'filesystem', id: `png-${saved.length}`, fileName: name, mimeType: mime };
			},
		},
	} as unknown as IExecuteFunctions;
	return { ctx, saved, reads, items };
}

test('renders selected pages into separate binary items with correct rotation and provenance', async () => {
	const run = context([fixturePdf()], { pages: '3,1-2,2', dpi: 72, inputDataFieldName: 'pdf', outputDataFieldName: 'image' });
	const [items] = await new PdfPagesToPng().execute.call(run.ctx);
	assert.equal(items.length, 3);
	assert.deepEqual(run.reads, [{ index: 0, field: 'pdf' }]);
	assert.deepEqual(items.map((item) => item.json.pdf_page_number), [1, 2, 3]);
	assert.deepEqual(items.map((item) => [item.json.pdf_width, item.json.pdf_height]), [[120, 80], [80, 120], [120, 80]]);
	items.forEach((item, index) => {
		assert.equal(item.json.marker, 'input-0');
		assert.equal(item.json.pdf_source_page_count, 3);
		assert.equal(item.json.pdf_selected_page_count, 3);
		assert.deepEqual(item.pairedItem, { item: 0 });
		assert.deepEqual(Object.keys(item.binary ?? {}), ['image']);
		assert.equal(item.binary?.image.id, `png-${index + 1}`);
		assert.equal(run.saved[index].mime, 'image/png');
		assert.equal(run.saved[index].name, `source-0-page-${index + 1}.png`);
		assert.deepEqual([...run.saved[index].bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
		assert.equal(run.saved[index].bytes.readUInt32BE(16), item.json.pdf_width);
		assert.equal(run.saved[index].bytes.readUInt32BE(20), item.json.pdf_height);
		assert.equal('data' in item.json, false);
	});
});

test('supports multiple PDFs and links each page to its own input', async () => {
	const run = context([fixturePdf(1), fixturePdf(1)], { pages: '*' });
	const [items] = await new PdfPagesToPng().execute.call(run.ctx);
	assert.deepEqual(items.map((item) => item.pairedItem), [{ item: 0 }, { item: 1 }]);
	assert.deepEqual(items.map((item) => item.json.marker), ['input-0', 'input-1']);
});

test('fails invalid pages, page limits, and raster limits before storing a PNG', async () => {
	for (const params of [{ pages: '4' }, { pages: '', options: { maxPages: 2 } }, { options: { maxPixels: 1 } }]) {
		const run = context([fixturePdf()], params);
		await assert.rejects(() => new PdfPagesToPng().execute.call(run.ctx));
		assert.equal(run.saved.length, 0);
	}
});

test('rejects missing binary, non-PDF data, and oversized input', async () => {
	const missing = context();
	delete missing.items[0].binary;
	await assert.rejects(() => new PdfPagesToPng().execute.call(missing.ctx), /missing/);
	const invalid = context([Buffer.from('not a PDF')]);
	await assert.rejects(() => new PdfPagesToPng().execute.call(invalid.ctx), /PDF header/);
	const large = context([fixturePdf()], { options: { maxInputBytes: 1 } });
	await assert.rejects(() => new PdfPagesToPng().execute.call(large.ctx), /Max Input Bytes/);
});

test('continue on fail emits only an error item and no binary for an output-limit failure', async () => {
	const run = context([fixturePdf()], { options: { maxOutputBytes: 1 } }, true);
	const [items] = await new PdfPagesToPng().execute.call(run.ctx);
	assert.equal(items.length, 1);
	assert.match(String(items[0].json.error), /Max Output Bytes/);
	assert.equal(items[0].binary, undefined);
	assert.deepEqual(items[0].pairedItem, { item: 0 });
});
