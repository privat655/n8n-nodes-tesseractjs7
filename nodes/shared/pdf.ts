import { countWords, recommendPageMode } from './quality';

type Matrix = [number, number, number, number, number, number];
type Rect = [number, number, number, number];
type OperatorList = { fnArray: number[]; argsArray: unknown[][] };
type PdfJsOps = Record<string, number>;

export type PdfPage = {
	getTextContent(): Promise<{ items: unknown[] }>;
	getOperatorList(): Promise<OperatorList>;
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

export type PageAnalysis = {
	page: number;
	text: string;
	wordCount: number;
	imageCoverage: number;
	recommendedMode: 'native' | 'ocr';
};

async function getPdfjs(): Promise<{ getDocument: (options: unknown) => { promise: Promise<unknown> }; OPS: PdfJsOps }> {
	return import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<{
		getDocument: (options: unknown) => { promise: Promise<unknown> };
		OPS: PdfJsOps;
	}>;
}

export async function loadPdf(buffer: Buffer): Promise<PdfDocument> {
	const pdfjs = await getPdfjs();
	return pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise as Promise<PdfDocument>;
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

function multiply(left: Matrix, right: Matrix): Matrix {
	return [
		left[0] * right[0] + left[2] * right[1],
		left[1] * right[0] + left[3] * right[1],
		left[0] * right[2] + left[2] * right[3],
		left[1] * right[2] + left[3] * right[3],
		left[0] * right[4] + left[2] * right[5] + left[4],
		left[1] * right[4] + left[3] * right[5] + left[5],
	];
}

function transformedRect(matrix: Matrix): Rect {
	const points = [
		[matrix[4], matrix[5]],
		[matrix[0] + matrix[4], matrix[1] + matrix[5]],
		[matrix[2] + matrix[4], matrix[3] + matrix[5]],
		[matrix[0] + matrix[2] + matrix[4], matrix[1] + matrix[3] + matrix[5]],
	];
	const xs = points.map(([x]) => x);
	const ys = points.map(([, y]) => y);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function clipRect(rect: Rect, width: number, height: number): Rect | undefined {
	const clipped: Rect = [
		Math.max(0, rect[0]),
		Math.max(0, rect[1]),
		Math.min(width, rect[2]),
		Math.min(height, rect[3]),
	];
	return clipped[2] > clipped[0] && clipped[3] > clipped[1] ? clipped : undefined;
}

export function unionArea(rects: Rect[]): number {
	const xs = [...new Set(rects.flatMap(([x0, , x1]) => [x0, x1]))].sort((a, b) => a - b);
	let area = 0;

	for (let index = 0; index < xs.length - 1; index++) {
		const left = xs[index];
		const right = xs[index + 1];
		const intervals = rects
			.filter(([x0, , x1]) => x0 < right && x1 > left)
			.map(([, y0, , y1]) => [y0, y1] as [number, number])
			.sort((a, b) => a[0] - b[0]);
		let coveredHeight = 0;
		let current: [number, number] | undefined;
		for (const interval of intervals) {
			if (!current || interval[0] > current[1]) {
				if (current) coveredHeight += current[1] - current[0];
				current = [...interval];
			} else {
				current[1] = Math.max(current[1], interval[1]);
			}
		}
		if (current) coveredHeight += current[1] - current[0];
		area += (right - left) * coveredHeight;
	}

	return area;
}

function asMatrix(value: unknown): Matrix | undefined {
	if (!Array.isArray(value) || value.length < 6 || !value.slice(0, 6).every(Number.isFinite)) return undefined;
	return value.slice(0, 6) as Matrix;
}

export function imageCoverageFromOperators(
	width: number,
	height: number,
	operators: OperatorList,
	ops: PdfJsOps,
): number {
	let matrix: Matrix = [1, 0, 0, 1, 0, 0];
	const stack: Matrix[] = [];
	const rects: Rect[] = [];
	const addRect = (transform: Matrix) => {
		const clipped = clipRect(transformedRect(transform), width, height);
		if (clipped) rects.push(clipped);
	};

	operators.fnArray.forEach((fn, index) => {
		const args = operators.argsArray[index] ?? [];
		if (fn === ops.save) {
			stack.push([...matrix]);
		} else if (fn === ops.restore) {
			matrix = stack.pop() ?? matrix;
		} else if (fn === ops.transform) {
			const transform = asMatrix(args);
			if (transform) matrix = multiply(matrix, transform);
		} else if (fn === ops.paintFormXObjectBegin) {
			stack.push([...matrix]);
			const transform = asMatrix(args[0]);
			if (transform) matrix = multiply(matrix, transform);
		} else if (fn === ops.paintFormXObjectEnd) {
			matrix = stack.pop() ?? matrix;
		} else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject) {
			addRect(matrix);
		} else if (fn === ops.paintImageXObjectRepeat) {
			const scaleX = Number(args[1]);
			const scaleY = Number(args[2]);
			const positions = args[3];
			if (Number.isFinite(scaleX) && Number.isFinite(scaleY) && Array.isArray(positions)) {
				for (let position = 0; position + 1 < positions.length; position += 2) {
					addRect(
						multiply(matrix, [scaleX, 0, 0, scaleY, Number(positions[position]), Number(positions[position + 1])]),
					);
				}
			}
		} else if (fn === ops.paintInlineImageXObjectGroup) {
			const placements = args[1];
			if (Array.isArray(placements)) {
				for (const placement of placements) {
					if (typeof placement !== 'object' || placement === null || !('transform' in placement)) continue;
					const transform = asMatrix((placement as { transform: unknown }).transform);
					if (transform) addRect(multiply(matrix, transform));
				}
			}
		}
	});

	return Math.min(1, unionArea(rects) / Math.max(width * height, 1));
}

export async function analyzePage(page: PdfPage, pageNumber: number): Promise<PageAnalysis> {
	const [text, operators, pdfjs] = await Promise.all([extractPageText(page), page.getOperatorList(), getPdfjs()]);
	const viewport = page.getViewport({ scale: 1 });
	const imageCoverage = imageCoverageFromOperators(viewport.width, viewport.height, operators, pdfjs.OPS);
	return {
		page: pageNumber,
		text,
		wordCount: countWords(text),
		imageCoverage,
		recommendedMode: recommendPageMode(text, imageCoverage),
	};
}

export async function analyzePages(pdf: PdfDocument, pageNumbers: number[]): Promise<PageAnalysis[]> {
	const analyses: PageAnalysis[] = [];
	for (const pageNumber of pageNumbers) {
		const page = await pdf.getPage(pageNumber);
		try {
			analyses.push(await analyzePage(page, pageNumber));
		} finally {
			page.cleanup();
		}
	}
	return analyses;
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

export function resolveSpecificPages(pageCount: number, value: string): number[] {
	if (!value.trim()) throw new Error('Pages must contain at least one page number');
	const parts = value.split(',').map((part) => part.trim());
	if (parts.some((part) => !/^\d+$/.test(part))) {
		throw new Error('Pages must be comma-separated positive integers, for example 1,5,6');
	}
	const pages = parts.map(Number);
	if (pages.some((page) => page < 1)) throw new Error('Pages must contain only integers greater than 0');
	if (new Set(pages).size !== pages.length) throw new Error('Pages must not contain duplicates');
	const outside = pages.find((page) => page > pageCount);
	if (outside) throw new Error(`Page ${outside} cannot exceed the document page count (${pageCount})`);
	return pages.sort((left, right) => left - right);
}
