import { createCanvas } from '@napi-rs/canvas';
import {
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeConnectionType,
	NodeOperationError,
} from 'n8n-workflow';
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { hasUsableNativeText } from './quality';

type PageResult = {
	page: number;
	text: string;
	confidence?: number;
};

type DocumentResult = {
	source: 'native' | 'ocr';
	pages: PageResult[];
};

async function withTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
	if (timeout <= 0) return promise;

	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`OCR timed out after ${timeout} ms`)), timeout);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

async function recognizePdf(
	buffer: Buffer,
	language: string,
	dpi: number,
	timeout: number,
): Promise<DocumentResult> {
	const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
	let worker: Worker | undefined;

	try {
		const nativePages: string[] = [];
		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
			const page = await pdf.getPage(pageNumber);
			const content = await page.getTextContent();
			nativePages.push(
				content.items
					.map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : ''))
					.join('')
					.replace(/[ \t]+\n/g, '\n')
					.replace(/[ \t]{2,}/g, ' ')
					.trim(),
			);
			page.cleanup();
		}

		if (hasUsableNativeText(nativePages)) {
			return {
				source: 'native',
				pages: nativePages.map((text, index) => ({ page: index + 1, text })),
			};
		}

		worker = await createWorker(language, OEM.LSTM_ONLY);
		await worker.setParameters({
			tessedit_pageseg_mode: PSM.AUTO,
			preserve_interword_spaces: '1',
			user_defined_dpi: String(dpi),
		});

		const pages: PageResult[] = [];
		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
			const page = await pdf.getPage(pageNumber);
			const viewport = page.getViewport({ scale: dpi / 72 });
			const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
			const context = canvas.getContext('2d');

			await page.render({
				canvasContext: context as unknown as CanvasRenderingContext2D,
				viewport,
				background: '#ffffff',
			}).promise;

			const result = await withTimeout(
				worker.recognize(canvas.toBuffer('image/png'), {}, { text: true }),
				timeout,
			);
			pages.push({ page: pageNumber, text: result.data.text, confidence: result.data.confidence });
			page.cleanup();
		}

		return { source: 'ocr', pages };
	} finally {
		await worker?.terminate();
		await pdf.destroy();
	}
}

export class TesseractNode implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'PDF Text Recognition',
		name: 'tesseractNode',
		icon: 'file:tesseract.svg',
		group: ['transform'],
		version: 2,
		description: 'Extract text from a PDF using its text layer or OCR',
		defaults: { name: 'PDF Text Recognition' },
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		properties: [
			{
				displayName: 'Input PDF Field',
				name: 'inputDataFieldName',
				type: 'string',
				default: 'data',
				description: 'Name of the binary field containing the PDF',
			},
			{
				displayName: 'Language',
				name: 'language',
				type: 'string',
				default: 'deu',
				description: 'Tesseract language code, for example deu or eng',
			},
			{
				displayName: 'DPI',
				name: 'dpi',
				type: 'number',
				default: 300,
				typeOptions: { minValue: 72, maxValue: 600 },
				description: 'Resolution used when the complete PDF requires OCR',
			},
			{
				displayName: 'OCR Timeout',
				name: 'timeout',
				type: 'number',
				default: 120000,
				typeOptions: { minValue: 0 },
				description: 'Maximum OCR time per page in milliseconds; 0 disables the timeout',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const field = this.getNodeParameter('inputDataFieldName', itemIndex, 'data') as string;
			const binary = items[itemIndex].binary?.[field];
			if (!binary) {
				throw new NodeOperationError(this.getNode(), `Binary field "${field}" is missing`, {
					itemIndex,
				});
			}
			if (binary.mimeType !== 'application/pdf') {
				throw new NodeOperationError(this.getNode(), `Binary field "${field}" must be a PDF`, {
					itemIndex,
				});
			}

			const result = await recognizePdf(
				await this.helpers.getBinaryDataBuffer(itemIndex, field),
				this.getNodeParameter('language', itemIndex, 'deu') as string,
				this.getNodeParameter('dpi', itemIndex, 300) as number,
				this.getNodeParameter('timeout', itemIndex, 120000) as number,
			);
			output.push({ json: result as unknown as IDataObject, pairedItem: { item: itemIndex } });
		}

		return [output];
	}
}
