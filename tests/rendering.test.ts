import assert from 'node:assert/strict';
import test from 'node:test';
import { IsolatedPdfRenderer } from '../nodes/shared/isolated-renderer';

function createComplexVectorPdf(): Buffer {
	const commands = [
		'q',
		'0 0 200 200 re W n',
		'1 0 0 rg 10 10 m 190 10 l 190 190 l 10 190 l h f',
		'0 0 1 rg 20 20 m 40 180 160 180 180 20 c h f',
		...Array.from({ length: 40 }, (_, index) => {
			const x = 5 + (index % 10) * 18;
			const y = 5 + Math.floor(index / 10) * 40;
			return `${x} ${y} 12 28 re f`;
		}),
		'Q',
	].join('\n');
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
		`<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
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

test('renders complex PDF paths in an isolated worker without changing parent globals', async () => {
	const previousPath2D = globalThis.Path2D;
	class ForeignPath2D {}
	globalThis.Path2D = ForeignPath2D as unknown as typeof Path2D;
	const renderer = await IsolatedPdfRenderer.create(createComplexVectorPdf(), 1);
	try {
		const png = await renderer.render(1, 144);
		assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
		assert.ok(png.length > 100);
		assert.equal(globalThis.Path2D, ForeignPath2D);
	} finally {
		await renderer.terminate();
		globalThis.Path2D = previousPath2D;
	}
});
