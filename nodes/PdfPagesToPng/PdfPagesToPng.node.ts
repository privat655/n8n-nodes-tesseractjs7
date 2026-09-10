import {
	type IDataObject, type IExecuteFunctions, type INode, type INodeExecutionData,
	type INodeType, type INodeTypeDescription, NodeConnectionType, NodeOperationError,
} from 'n8n-workflow';
import { IsolatedPdfRenderer, type PercentageRegion } from '../shared/isolated-renderer';
import { selectPdfPages } from '../shared/pageSelection';

const ZOOM_DPI = 300;

function positiveInteger(value: unknown, name: string, node: INode, itemIndex: number): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw new NodeOperationError(node, `${name} must be a positive safe integer`, { itemIndex });
	}
	return value;
}

function parseRegion(value: unknown, node: INode, itemIndex: number): PercentageRegion | undefined {
	if (value === null || value === undefined || value === '') return undefined;
	if (typeof value !== 'string') throw new NodeOperationError(node, 'Region must be a string', { itemIndex });
	const text = value.trim();
	if (!text) return undefined;
	if (!text.startsWith('pct:')) {
		throw new NodeOperationError(node, 'Region must use pct:x,y,w,h notation', { itemIndex });
	}
	const parts = text.slice(4).split(',').map((part) => part.trim());
	if (parts.length !== 4 || parts.some((part) => !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(part))) {
		throw new NodeOperationError(node, 'Region must use pct:x,y,w,h with four numeric percentage values', { itemIndex });
	}
	const [x, y, width, height] = parts.map(Number);
	if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 100 || y + height > 100) {
		throw new NodeOperationError(node, 'Region percentages must stay inside the page and width/height must be greater than zero', { itemIndex });
	}
	return { x, y, width, height };
}

function regionText(region: PercentageRegion): string {
	return `pct:${region.x},${region.y},${region.width},${region.height}`;
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
		description: 'Render selected PDF pages or one percentage region as PNG binary files without OCR',
		defaults: { name: 'PDF Pages to PNG' },
		// eslint-disable-next-line n8n-nodes-base/node-class-description-inputs-wrong-regular-node
		inputs: [NodeConnectionType.Main],
		// eslint-disable-next-line n8n-nodes-base/node-class-description-outputs-wrong
		outputs: [NodeConnectionType.Main],
		properties: [
			{ displayName: 'Input PDF Field', name: 'inputDataFieldName', type: 'string', default: 'data', description: 'Name of the binary field containing the source PDF' },
			{ displayName: 'Output PNG Field', name: 'outputDataFieldName', type: 'string', default: 'data', description: 'Binary field containing one PNG per output item' },
			{ displayName: 'Pages', name: 'pages', type: 'string', default: '', description: 'Physical page numbers starting at 1. Empty or * means all pages. Example: 1,3-5,15. Overlaps are deduplicated and sorted.' },
			{ displayName: 'Region', name: 'region', type: 'string', default: '', placeholder: 'pct:70,10,10,10', description: 'Optional percentage crop relative to the complete displayed PDF page: pct:x,y,w,h from the top-left. Requires exactly one selected page and renders at 300 DPI.' },
			{ displayName: 'DPI', name: 'dpi', type: 'number', default: 150, typeOptions: { minValue: 36, maxValue: 600 }, description: 'Full-page render resolution. Ignored when Region is set; region renders always use 300 DPI.' },
			{
				displayName: 'Options', name: 'options', type: 'collection', placeholder: 'Add Option', default: {},
				options: [
					{ displayName: 'Max Input Bytes', name: 'maxInputBytes', type: 'number', default: 52428800, typeOptions: { minValue: 1, numberPrecision: 0 }, description: 'Maximum source PDF size before parsing' },
					{ displayName: 'Max Output Bytes', name: 'maxOutputBytes', type: 'number', default: 134217728, typeOptions: { minValue: 1, numberPrecision: 0 }, description: 'Maximum total PNG bytes per input PDF; exceeding it fails the whole input item' },
					{ displayName: 'Max Pages', name: 'maxPages', type: 'number', default: 100, typeOptions: { minValue: 1, numberPrecision: 0 }, description: 'Maximum number of selected pages; pages are never silently truncated' },
					{ displayName: 'Max Pixels per Page', name: 'maxPixels', type: 'number', default: 25000000, typeOptions: { minValue: 1, numberPrecision: 0 }, description: 'Maximum output raster width times height, checked before rendering any page or region' },
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
				if (!inputField || !outputField) throw new NodeOperationError(this.getNode(), 'Input and output binary field names must not be empty', { itemIndex });
				const sourceBinary = items[itemIndex].binary?.[inputField];
				if (!sourceBinary) throw new NodeOperationError(this.getNode(), `Binary field "${inputField}" is missing`, { itemIndex });
				const selection = this.getNodeParameter('pages', itemIndex, '') as string;
				const region = parseRegion(this.getNodeParameter('region', itemIndex, ''), this.getNode(), itemIndex);
				const configuredDpi = this.getNodeParameter('dpi', itemIndex, 150) as number;
				const dpi = region ? ZOOM_DPI : configuredDpi;
				if (!region && (!Number.isFinite(dpi) || dpi < 36 || dpi > 600)) throw new NodeOperationError(this.getNode(), 'DPI must be between 36 and 600', { itemIndex });
				const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
				const maxInputBytes = positiveInteger(options.maxInputBytes ?? 52428800, 'Max Input Bytes', this.getNode(), itemIndex);
				const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 134217728, 'Max Output Bytes', this.getNode(), itemIndex);
				const maxPages = positiveInteger(options.maxPages ?? 100, 'Max Pages', this.getNode(), itemIndex);
				const maxPixels = positiveInteger(options.maxPixels ?? 25000000, 'Max Pixels per Page', this.getNode(), itemIndex);
				const renderTimeout = positiveInteger(options.renderTimeoutMs ?? 60000, 'Render Timeout', this.getNode(), itemIndex);
				if (renderTimeout > 300000) throw new NodeOperationError(this.getNode(), 'Render Timeout must not exceed 300000 ms', { itemIndex });
				const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, inputField);
				if (buffer.length > maxInputBytes) throw new NodeOperationError(this.getNode(), `PDF exceeds Max Input Bytes (${maxInputBytes})`, { itemIndex });
				if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new NodeOperationError(this.getNode(), 'Input does not contain a PDF header', { itemIndex });

				// Parse and inspect in the same isolate as rendering; do not load native canvas in n8n's parent isolate.
				renderer = await IsolatedPdfRenderer.create(buffer, 1);
				const pageCount = renderer.pageCount;
				const selectedPages = selectPdfPages(pageCount, selection, maxPages);
				if (region && selectedPages.length !== 1) {
					throw new NodeOperationError(this.getNode(), 'Region requires exactly one selected physical PDF page', { itemIndex });
				}
				const plan: Array<{ page: number; width: number; height: number; fullWidth: number; fullHeight: number }> = [];
				for (const pageNumber of selectedPages) {
					const dimensions = await timedOperation(renderer.inspect(pageNumber, dpi, region), pageNumber, renderTimeout);
					const { width, height } = dimensions;
					if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 32767 || height > 32767 || width * height > maxPixels) {
						throw new NodeOperationError(this.getNode(), `Page ${pageNumber} raster (${width}x${height}) exceeds the raster limits; reduce DPI or use a smaller region`, { itemIndex });
					}
					plan.push({ page: pageNumber, ...dimensions });
				}
				const sourceName = sourceBinary.fileName || 'document.pdf';
				const baseName = (sourceName.split(/[\\/]/).pop() || 'document').replace(/\.pdf$/i, '').replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, 160) || 'document';
				const normalizedRegion = region ? regionText(region) : undefined;
				const regionFileToken = normalizedRegion ? `-region-${normalizedRegion.slice(4).replace(/,/g, '-').replace(/\./g, '_')}` : '';
				const documentOutput: INodeExecutionData[] = [];
				let totalBytes = 0;
				for (const page of plan) {
					const png = await timedOperation(renderer.render(page.page, dpi, region), page.page, renderTimeout);
					totalBytes += png.length;
					if (totalBytes > maxOutputBytes) throw new NodeOperationError(this.getNode(), `PNG output exceeds Max Output Bytes (${maxOutputBytes})`, { itemIndex });
					const binary = await this.helpers.prepareBinaryData(png, `${baseName}-page-${page.page}${regionFileToken}.png`, 'image/png');
					const regionMetadata = normalizedRegion ? {
						pdf_region: normalizedRegion,
						pdf_source_width: page.fullWidth,
						pdf_source_height: page.fullHeight,
					} : {};
					documentOutput.push({
						json: { ...items[itemIndex].json,
							pdf_page_number: page.page, pdf_source_page_count: pageCount,
							pdf_selected_page_count: plan.length, pdf_render_dpi: dpi,
							pdf_width: page.width, pdf_height: page.height,
							pdf_png_size_bytes: png.length, pdf_source_file_name: sourceName,
							...regionMetadata },
						binary: { [outputField]: binary }, pairedItem: { item: itemIndex },
					});
				}
				output.push(...documentOutput);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!this.continueOnFail()) {
					if (error instanceof NodeOperationError) throw error;
					throw new NodeOperationError(this.getNode(), message, { itemIndex });
				}
				output.push({ json: { ...items[itemIndex].json, error: message }, pairedItem: { item: itemIndex } });
			} finally { if (renderer) await renderer.terminate(); }
		}
		return [output];
	}
}
