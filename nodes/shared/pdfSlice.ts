import { PDFDocument } from 'pdf-lib';

export type PdfSliceResult = {
	bytes: Uint8Array;
	pageCount: number;
};

export function validatePageSlice(pageCount: number, pageFrom: number, pageTo: number): void {
	if (!Number.isInteger(pageFrom) || pageFrom < 1) {
		throw new Error('Page From must be an integer greater than 0');
	}
	if (!Number.isInteger(pageTo) || pageTo < 1) {
		throw new Error('Page To must be an integer greater than 0');
	}
	if (pageTo < pageFrom) {
		throw new Error('Page To must be greater than or equal to Page From');
	}
	if (pageFrom > pageCount) {
		throw new Error(`Page From cannot exceed the document page count (${pageCount})`);
	}
	if (pageTo > pageCount) {
		throw new Error(`Page To cannot exceed the document page count (${pageCount})`);
	}
}

export async function slicePdfBuffer(buffer: Buffer, pageFrom: number, pageTo: number): Promise<PdfSliceResult> {
	const source = await PDFDocument.load(buffer);
	const pageCount = source.getPageCount();
	validatePageSlice(pageCount, pageFrom, pageTo);

	const target = await PDFDocument.create();
	const indexes = Array.from({ length: pageTo - pageFrom + 1 }, (_, index) => pageFrom - 1 + index);
	const pages = await target.copyPages(source, indexes);
	for (const page of pages) target.addPage(page);

	return {
		bytes: await target.save({ useObjectStreams: true }),
		pageCount,
	};
}
