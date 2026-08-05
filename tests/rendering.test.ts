import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPdf, renderPageToPng } from '../nodes/shared/pdf';

function createVectorPdf(): Buffer {
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
		'<< /Length 32 >>\nstream\nq 1 0 0 rg 10 10 180 180 re f Q\nendstream',
	];
	let pdf = '%PDF-1.4\n';
	const offsets = [0];
	for (let index = 0; index < objects.length; index++) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf, 'binary');
}

test('renders a PDF page with the PDF.js canvas factory', async () => {
	const pdf = await loadPdf(createVectorPdf());
	try {
		const png = await renderPageToPng(pdf, 1, 144);
		assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
		assert.ok(png.length > 100);
	} finally {
		await pdf.destroy();
	}
});
