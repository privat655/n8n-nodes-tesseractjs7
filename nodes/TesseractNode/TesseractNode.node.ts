import {
	type IDataObject,
	type IExecuteFunctions,
	type INode,
	type INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeConnectionType,
	NodeOperationError,
} from 'n8n-workflow';
import { createScheduler, createWorker, OEM, PSM, type Scheduler, type Worker } from 'tesseract.js';
import { mapLimit } from '../shared/concurrency';
import { IsolatedPdfRenderer } from '../shared/isolated-renderer';
import {
	analyzePages,
	extractNativePages,
	loadPdf,
	resolvePageRange,
	resolveSpecificPages,
	type PageAnalysis,
	type PdfDocument,
} from '../shared/pdf';

type RecognitionMode = 'auto' | 'native' | 'ocr';
type PageSelection = 'range' | 'specific';
type PageSource = 'native' | 'ocr';

type PageResult = { page: number; source: PageSource; text: string; confidence?: number };
type DocumentResult = {
	source: PageSource | 'mixed';
	pageCount: number;
	range?: { from: number; to: number };
	selectedPages?: number[];
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
		await Promise.all(Array.from({ length: workerCount }, async () => {
			const worker = await createWorker(language, OEM.LSTM_ONLY);
			workers.push(worker);
			await worker.setParameters({
				tessedit_pageseg_mode: PSM.AUTO,
				preserve_interword_spaces: '1',
				user_defined_dpi: String(dpi),
			});
			scheduler.addWorker(worker);
		}));
		return scheduler;
	} catch (error) {
		await Promise.all(workers.map(async (worker) => worker.terminate()));
		throw error;
	}
}

async function recognizePages(
	node: INode,
	buffer: Buffer,
	pageNumbers: number[],
	language: string,
	dpi: number,
	timeout: number,
): Promise<PageResult[]> {
	if (pageNumbers.length === 0) return [];
	const workerCount = Math.min(3, pageNumbers.length);
	const [scheduler, renderer] = await Promise.all([
		createOcrScheduler(workerCount, language, dpi),
		IsolatedPdfRenderer.create(buffer, workerCount),
	]);
	try {
		return await mapLimit(pageNumbers, 3, async (pageNumber) => {
			const image = await renderer.render(pageNumber, dpi);
			try {
				const result = await withTimeout(
					scheduler.addJob('recognize', image, {}, { text: true }),
					timeout,
				);
				return { page: pageNumber, source: 'ocr', text: result.data.text, confidence: result.data.confidence };
			} catch (error) {
				throw new NodeOperationError(
					node,
					`Failed to OCR PDF page ${pageNumber}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
	} finally {
		await Promise.all([scheduler.terminate(), renderer.terminate()]);
	}
}

function documentSource(pages: PageResult[]): DocumentResult['source'] {
	const sources = new Set(pages.map((page) => page.source));
	return sources.size === 1 ? pages[0].source : 'mixed';
}

function nativeResults(analyses: PageAnalysis[]): PageResult[] {
	return analyses.map(({ page, text }) => ({ page, source: 'native', text }));
}

async function recognizePdf(
	node: INode,
	buffer: Buffer,
	mode: RecognitionMode,
	pageSelection: PageSelection,
	pageFrom: number,
	pageTo: number,
	specificPages: string,
	language: string,
	dpi: number,
	timeout: number,
): Promise<DocumentResult> {
	const pdf: PdfDocument = await loadPdf(buffer);
	try {
		const selectedPages = pageSelection === 'specific'
			? resolveSpecificPages(pdf.numPages, specificPages)
			: resolvePageRange(pdf.numPages, pageFrom, pageTo);
		let pages: PageResult[];
		if (mode === 'ocr') {
			pages = await recognizePages(node, buffer, selectedPages, language, dpi, timeout);
		} else if (mode === 'native') {
			const texts = await extractNativePages(pdf, selectedPages);
			pages = texts.map((text, index) => ({ page: selectedPages[index], source: 'native', text }));
		} else {
			const analyses = await analyzePages(pdf, selectedPages);
			const native = nativeResults(analyses.filter((page) => page.recommendedMode === 'native'));
			const ocrPages = analyses.filter((page) => page.recommendedMode === 'ocr').map((page) => page.page);
			const ocr = await recognizePages(node, buffer, ocrPages, language, dpi, timeout);
			pages = [...native, ...ocr].sort((left, right) => left.page - right.page);
		}
		return {
			source: documentSource(pages),
			pageCount: pdf.numPages,
			...(pageSelection === 'specific'
				? { selectedPages }
				: { range: { from: selectedPages[0], to: selectedPages[selectedPages.length - 1] } }),
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
		version: 2.4,
		description: 'Extract text from selected PDF pages using their text layer or OCR',
		defaults: { name: 'PDF Text Recognition' },
		// eslint-disable-next-line n8n-nodes-base/node-class-description-inputs-wrong-regular-node
		inputs: [NodeConnectionType.Main],
		// eslint-disable-next-line n8n-nodes-base/node-class-description-outputs-wrong
		outputs: [NodeConnectionType.Main],
		properties: [
			{ displayName: 'Input PDF Field', name: 'inputDataFieldName', type: 'string', default: 'data', description: 'Name of the binary field containing the PDF' },
			{ displayName: 'Recognition Mode', name: 'recognitionMode', type: 'options', default: 'auto', options: [{ name: 'Auto', value: 'auto' }, { name: 'Native Text', value: 'native' }, { name: 'OCR', value: 'ocr' }], description: 'Auto chooses native text or OCR separately for every selected page' },
			{ displayName: 'Page Selection', name: 'pageSelection', type: 'options', default: 'range', options: [{ name: 'Range', value: 'range' }, { name: 'Specific Pages', value: 'specific' }] },
			{ displayName: 'Page From', name: 'pageFrom', type: 'number', default: 1, typeOptions: { minValue: 1, numberStepSize: 1 }, displayOptions: { show: { pageSelection: ['range'] } } },
			{ displayName: 'Page To', name: 'pageTo', type: 'number', default: 0, typeOptions: { minValue: 0, numberStepSize: 1 }, displayOptions: { show: { pageSelection: ['range'] } }, description: 'Use 0 for the last page' },
			{ displayName: 'Pages', name: 'specificPages', type: 'string', default: '', displayOptions: { show: { pageSelection: ['specific'] } }, placeholder: '1,5,6', description: 'Comma-separated PDF page numbers, for example 1,5,6' },
			{ displayName: 'Language', name: 'language', type: 'string', default: 'deu', description: 'Tesseract language code, for example deu or eng' },
			{ displayName: 'DPI', name: 'dpi', type: 'number', default: 300, typeOptions: { minValue: 72, maxValue: 600 }, description: 'Resolution used when OCR is required' },
			{ displayName: 'OCR Timeout', name: 'timeout', type: 'number', default: 120000, typeOptions: { minValue: 0 }, description: 'Maximum OCR time per page in milliseconds; 0 disables the timeout' },
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const field = this.getNodeParameter('inputDataFieldName', itemIndex, 'data') as string;
			const binary = items[itemIndex].binary?.[field];
			if (!binary) throw new NodeOperationError(this.getNode(), `Binary field "${field}" is missing`, { itemIndex });
			try {
				const result = await recognizePdf(
					this.getNode(),
					await this.helpers.getBinaryDataBuffer(itemIndex, field),
					this.getNodeParameter('recognitionMode', itemIndex, 'auto') as RecognitionMode,
					this.getNodeParameter('pageSelection', itemIndex, 'range') as PageSelection,
					this.getNodeParameter('pageFrom', itemIndex, 1) as number,
					this.getNodeParameter('pageTo', itemIndex, 0) as number,
					this.getNodeParameter('specificPages', itemIndex, '') as string,
					this.getNodeParameter('language', itemIndex, 'deu') as string,
					this.getNodeParameter('dpi', itemIndex, 300) as number,
					this.getNodeParameter('timeout', itemIndex, 120000) as number,
				);

				const context = { ...(items[itemIndex].json as IDataObject) };
				delete context.pages;
				delete context.pageCount;
				delete context.recommendedMode;
				delete context.nativePageCount;
				delete context.ocrPageCount;
				delete context.downloaded_base64;
				delete context.attachment_base64;
				delete context.attachments_to_process;

				output.push({
					json: { ...context, recognition_result: result } as IDataObject,
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (error instanceof NodeOperationError) throw error;
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}
		return [output];
	}
}
