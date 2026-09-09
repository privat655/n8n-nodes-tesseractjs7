import {
	type IDataObject, type IExecuteFunctions, type INodeExecutionData,
	type INodeType, type INodeTypeDescription, NodeConnectionType, NodeOperationError,
} from 'n8n-workflow';
import { IsolatedPdfRenderer } from '../shared/isolated-renderer';
import { selectPdfPages } from '../shared/pageSelection';

function positiveInteger(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
	return value;
}
async function timedOperation<T>(operation: Promise<T>, page: number, timeout: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([operation, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Processing page ${page} exceeded ${timeout} ms`)), timeout);
		})]);
	} finally { if (timer) clearTimeout(timer); }
}

export class PdfPagesToPng implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'PDF Pages to PNG', name: 'pdfPagesToPng', icon: 'file:pdfPagesToPng.svg',
		group: ['transform'], version: 1,
		description: 'Render selected PDF pages as individual PNG binary files without OCR',
		defaults: { name: 'PDF Pages to PNG' },
		// eslint-disable-next-line n8n-nodes-base/node-class-description-inputs-wrong-regular-node
		inputs: [NodeConnectionType.Main],
		// eslint-disable-next-line n8n-nodes-base/node-class-description-outputs-wrong
		outputs: [NodeConnectionType.Main],
		properties: [
			{ displayName: 'Input PDF Field', name: 'inputDataFieldName', type: 'string', default: 'data', description: 'Name of the binary field containing the source PDF' },
			{ displayName: 'Output PNG Field', name: 'outputDataFieldName', type: 'string', default: 'data', description: 'Binary field containing one PNG per output item' },
			{ displayName: 'Pages', name: 'pages', type: 'string', default: '', description: 'Physical page numbers starting at 1. Empty or * means all pages. Example: 1,3-5,15. Overlaps are deduplicated and sorted.' },
			{ displayName: 'DPI', name: 'dpi', type: 'number', default: 150, typeOptions: { minValue: 36, maxValue: 600 }, description: 'Render resolution; large drawings may require a lower value to fit the pixel limit' },
			{
				displayName: 'Options', name: 'options', type: 'collection', placeholder: 'Add Option', default: {},
				options: [
					{ displayName: 'Max Input Bytes', name: 'maxInputBytes', type: 'number', default: 52428800, typeOptions: { minValue: 1, numberPrecision: 0 }, description: 'Maximum source PDF size before parsing' },
					{ displayName: 'Max Output Bytes', name: 'maxOutputBytes', type: 'number', default: 134217728, typeOptions: { minValue: 1, numberPrecision: 0 }, description: 'Maximum total PNG bytes per input PDF; exceeding it fails the whole input item' },
					{ displayName: 'Max Pages', name: 'maxPages', type: 'number', default: 100, typeOptions: { minValue: 1, numberPrecision: 0 }, description: 'Maximum number of selected pages; pages are never silently truncated' },
					{ displayName: 'Max Pixels per Page', name: 'maxPixels', type: 'number', default: 25000000, typeOptions: { minValue: 1, numberPrecision: 0 }, description: 'Maximum raster width times height, checked before rendering any page' },
					{ displayName: 'Render Timeout (Ms)', name: 'renderTimeoutMs', type: 'number', default: 60000, typeOptions: { minValue: 1, maxValue: 300000, numberPrecision: 0 }, description: 'Timeout for processing one page after the renderer has started' },
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			let renderer: IsolatedPdfRenderer | undefined;
			try {
				const inputField = (this.getNodeParameter('inputDataFieldName', itemIndex, 'data') as string).trim();
				const outputField = (this.getNodeParameter('outputDataFieldName', itemIndex, 'data') as string).trim();
				if (!inputField || !outputField) throw new Error('Input and output binary field names must not be empty');
				const sourceBinary = items[itemIndex].binary?.[inputField];
				if (!sourceBinary) throw new Error(`Binary field "${inputField}" is missing`);
				const selection = this.getNodeParameter('pages', itemIndex, '') as string;
				const dpi = this.getNodeParameter('dpi', itemIndex, 150) as number;
				if (!Number.isFinite(dpi) || dpi < 36 || dpi > 600) throw new Error('DPI must be between 36 and 600');
				const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
				const maxInputBytes = positiveInteger(options.maxInputBytes ?? 52428800, 'Max Input Bytes');
				const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 134217728, 'Max Output Bytes');
				const maxPages = positiveInteger(options.maxPages ?? 100, 'Max Pages');
				const maxPixels = positiveInteger(options.maxPixels ?? 25000000, 'Max Pixels per Page');
				const renderTimeout = positiveInteger(options.renderTimeoutMs ?? 60000, 'Render Timeout');
				if (renderTimeout > 300000) throw new Error('Render Timeout must not exceed 300000 ms');
				const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, inputField);
				if (buffer.length > maxInputBytes) throw new Error(`PDF exceeds Max Input Bytes (${maxInputBytes})`);
				if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Input does not contain a PDF header');

				// Parse and inspect in the same isolate as rendering; do not load native canvas in n8n's parent isolate.
				renderer = await IsolatedPdfRenderer.create(buffer, 1);
				const pageCount = renderer.pageCount;
				const plan: Array<{ page: number; width: number; height: number }> = [];
				for (const pageNumber of selectPdfPages(pageCount, selection, maxPages)) {
					const { width, height } = await timedOperation(renderer.inspect(pageNumber, dpi), pageNumber, renderTimeout);
					if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 32767 || height > 32767 || width * height > maxPixels) {
						throw new Error(`Page ${pageNumber} raster (${width}x${height}) exceeds the raster limits; reduce DPI`);
					}
					plan.push({ page: pageNumber, width, height });
				}
				const sourceName = sourceBinary.fileName || 'document.pdf';
				const baseName = (sourceName.split(/[\\/]/).pop() || 'document').replace(/\.pdf$/i, '').replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, 160) || 'document';
				const documentOutput: INodeExecutionData[] = [];
				let totalBytes = 0;
				for (const page of plan) {
					const png = await timedOperation(renderer.render(page.page, dpi), page.page, renderTimeout);
					totalBytes += png.length;
					if (totalBytes > maxOutputBytes) throw new Error(`PNG output exceeds Max Output Bytes (${maxOutputBytes})`);
					const binary = await this.helpers.prepareBinaryData(png, `${baseName}-page-${page.page}.png`, 'image/png');
					documentOutput.push({
						json: { ...items[itemIndex].json,
							pdf_page_number: page.page, pdf_source_page_count: pageCount,
							pdf_selected_page_count: plan.length, pdf_render_dpi: dpi,
							pdf_width: page.width, pdf_height: page.height,
							pdf_png_size_bytes: png.length, pdf_source_file_name: sourceName },
						binary: { [outputField]: binary }, pairedItem: { item: itemIndex },
					});
				}
				output.push(...documentOutput);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!this.continueOnFail()) throw new NodeOperationError(this.getNode(), message, { itemIndex });
				output.push({ json: { ...items[itemIndex].json, error: message }, pairedItem: { item: itemIndex } });
			} finally { if (renderer) await renderer.terminate(); }
		}
		return [output];
	}
}
