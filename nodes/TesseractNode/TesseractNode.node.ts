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
import { createScheduler, createWorker, OEM, PSM, type Scheduler, type Worker } from 'tesseract.js';
import { mapLimit } from '../shared/concurrency';
import { extractNativePages, loadPdf, resolvePageRange, type PdfDocument } from '../shared/pdf';
import { hasUsableNativeText } from '../shared/quality';

type RecognitionMode = 'auto' | 'native' | 'ocr';

type PageResult = {
	page: number;
	text: string;
	confidence?: number;
};

type DocumentResult = {
	source: 'native' | 'ocr';
	pageCount: number;
	range: { from: number; to: number };
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

async function createOcrScheduler(workerCount: number, language: string, dpi: number): Promise<Scheduler> {
	const scheduler = createScheduler();
	const workers: Worker[] = [];

	try {
		await Promise.all(
			Array.from({ length: workerCount }, async () => {
				const worker = await createWorker(language, OEM.LSTM_ONLY);
				workers.push(worker);
				await worker.setParameters({
					tessedit_pageseg_mode: PSM.AUTO,
					preserve_interword_spaces: '1',
					user_defined_dpi: String(dpi),
				});
				scheduler.addWorker(worker);
			}),
		);
		return scheduler;
	} catch (error) {
		await Promise.all(workers.map(async (worker) => worker.terminate()));
		throw error;
	}
}

async function recognizePages(
	pdf: PdfDocument,
	pageNumbers: number[],
	language: string,
	dpi: number,
	timeout: number,
): Promise<PageResult[]> {
	const scheduler = await createOcrScheduler(Math.min(3, pageNumbers.length), language, dpi);
	try {
		return await mapLimit(pageNumbers, 3, async (pageNumber) => {
			const page = await pdf.getPage(pageNumber);
			try {
				const viewport = page.getViewport({ scale: dpi / 72 });
				const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
				await page.render({
					canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
					viewport,
					background: '#ffffff',
				}).promise;

				const result = await withTimeout(
					scheduler.addJob('recognize', canvas.toBuffer('image/png'), {}, { text: true }),
					timeout,
				);
				return { page: pageNumber, text: result.data.text, confidence: result.data.confidence };
			} finally {
				page.cleanup();
			}
		});
	} finally {
		await scheduler.terminate();
	}
}

async function recognizePdf(
	buffer: Buffer,
	mode: RecognitionMode,
	pageFrom: number,
	pageTo: number,
	language: string,
	dpi: number,
	timeout: number,
): Promise<DocumentResult> {
	const pdf = await loadPdf(buffer);
	try {
		const selectedPages = resolvePageRange(pdf.numPages, pageFrom, pageTo);
		let source: 'native' | 'ocr' = mode === 'ocr' ? 'ocr' : 'native';
		let nativePages: string[] | undefined;

		if (mode === 'auto') {
			const allPageNumbers = Array.from({ length: pdf.numPages }, (_, index) => index + 1);
			nativePages = await extractNativePages(pdf, allPageNumbers);
			source = hasUsableNativeText(nativePages) ? 'native' : 'ocr';
		}

		let pages: PageResult[];
		if (source === 'ocr') {
			pages = await recognizePages(pdf, selectedPages, language, dpi, timeout);
		} else if (nativePages) {
			pages = selectedPages.map((page) => ({ page, text: nativePages[page - 1] ?? '' }));
		} else {
			const texts = await extractNativePages(pdf, selectedPages);
			pages = texts.map((text, index) => ({ page: selectedPages[index], text }));
		}

		return {
			source,
			pageCount: pdf.numPages,
			range: { from: selectedPages[0], to: selectedPages[selectedPages.length - 1] },
			pages,
		};
	} finally {
		await pdf.destroy();
	}
}

export class TesseractNode implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'PDF Text Recognition',
		name: 'tesseractNode',
		icon: 'file:tesseract.svg',
		group: ['transform'],
		version: 2.1,
		description: 'Extract text from a PDF using its text layer or OCR',
		defaults: { name: 'PDF Text Recognition' },
		// eslint-disable-next-line n8n-nodes-base/node-class-description-inputs-wrong-regular-node
		inputs: [NodeConnectionType.Main],
		// eslint-disable-next-line n8n-nodes-base/node-class-description-outputs-wrong
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
				displayName: 'Recognition Mode',
				name: 'recognitionMode',
				type: 'options',
				default: 'auto',
				options: [
					{ name: 'Auto', value: 'auto' },
					{ name: 'Native Text', value: 'native' },
					{ name: 'OCR', value: 'ocr' },
				],
				description: 'Auto checks the complete PDF; native and OCR skip that check',
			},
			{
				displayName: 'Page From',
				name: 'pageFrom',
				type: 'number',
				default: 1,
				typeOptions: { minValue: 1, numberStepSize: 1 },
			},
			{
				displayName: 'Page To',
				name: 'pageTo',
				type: 'number',
				default: 0,
				typeOptions: { minValue: 0, numberStepSize: 1 },
				description: 'Use 0 for the last page',
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
				description: 'Resolution used when OCR is required',
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
				throw new NodeOperationError(this.getNode(), `Binary field "${field}" is missing`, { itemIndex });
			}
			if (binary.mimeType !== 'application/pdf') {
				throw new NodeOperationError(this.getNode(), `Binary field "${field}" must be a PDF`, { itemIndex });
			}

			try {
				const result = await recognizePdf(
					await this.helpers.getBinaryDataBuffer(itemIndex, field),
					this.getNodeParameter('recognitionMode', itemIndex, 'auto') as RecognitionMode,
					this.getNodeParameter('pageFrom', itemIndex, 1) as number,
					this.getNodeParameter('pageTo', itemIndex, 0) as number,
					this.getNodeParameter('language', itemIndex, 'deu') as string,
					this.getNodeParameter('dpi', itemIndex, 300) as number,
					this.getNodeParameter('timeout', itemIndex, 120000) as number,
				);
				output.push({ json: result as unknown as IDataObject, pairedItem: { item: itemIndex } });
			} catch (error) {
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [output];
	}
}
