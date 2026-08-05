export type PdfPage = {
	getTextContent(): Promise<{ items: unknown[] }>;
	getViewport(options: { scale: number }): { width: number; height: number };
	render(options: {
		canvasContext: CanvasRenderingContext2D;
		viewport: unknown;
		background: string;
	}): { promise: Promise<void> };
	cleanup(): void;
};

export type PdfDocument = {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPage>;
	destroy(): Promise<void>;
};

export async function loadPdf(buffer: Buffer): Promise<PdfDocument> {
	const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
	return pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise as unknown as PdfDocument;
}

export async function extractPageText(page: PdfPage): Promise<string> {
	const content = await page.getTextContent();
	return content.items
		.map((item) => {
			if (typeof item !== 'object' || item === null || !('str' in item)) return '';
			const textItem = item as { str: string; hasEOL?: boolean };
			return `${textItem.str}${textItem.hasEOL ? '\n' : ' '}`;
		})
		.join('')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}

export async function extractNativePages(pdf: PdfDocument, pageNumbers: number[]): Promise<string[]> {
	const texts: string[] = [];
	for (const pageNumber of pageNumbers) {
		const page = await pdf.getPage(pageNumber);
		try {
			texts.push(await extractPageText(page));
		} finally {
			page.cleanup();
		}
	}
	return texts;
}

export function resolvePageRange(pageCount: number, pageFrom: number, pageTo: number): number[] {
	if (!Number.isInteger(pageFrom) || pageFrom < 1) throw new Error('Page From must be an integer greater than 0');
	if (!Number.isInteger(pageTo) || pageTo < 0) throw new Error('Page To must be 0 or a positive integer');
	const end = pageTo === 0 ? pageCount : pageTo;
	if (end < pageFrom) throw new Error('Page To must be greater than or equal to Page From');
	if (end > pageCount) throw new Error(`Page To cannot exceed the document page count (${pageCount})`);
	return Array.from({ length: end - pageFrom + 1 }, (_, index) => pageFrom + index);
}
