import {
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeConnectionType,
	NodeOperationError,
} from 'n8n-workflow';
import { analyzePage, loadPdf, type PageAnalysis } from '../shared/pdf';

export class PdfRecognitionPreflight implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'PDF Recognition Preflight',
		name: 'pdfRecognitionPreflight',
		icon: 'file:tesseract.svg',
		group: ['transform'],
		version: 1.3,
		description: 'Inspect PDF pages sequentially and recommend native text extraction or OCR',
		defaults: { name: 'PDF Recognition Preflight' },
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
				displayName: 'Stop After OCR Pages',
				name: 'stopAfterOcrPages',
				type: 'number',
				default: 0,
				typeOptions: { minValue: 0, numberPrecision: 0 },
				description: 'Stop scanning as soon as this many OCR pages are found; 0 analyzes the complete PDF',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const field = this.getNodeParameter('inputDataFieldName', itemIndex, 'data') as string;
			const stopAfterOcrPages = Math.max(
				0,
				Math.floor(this.getNodeParameter('stopAfterOcrPages', itemIndex, 0) as number),
			);
			const binary = items[itemIndex].binary?.[field];
			if (!binary) {
				throw new NodeOperationError(this.getNode(), `Binary field "${field}" is missing`, { itemIndex });
			}

			const pdf = await loadPdf(await this.helpers.getBinaryDataBuffer(itemIndex, field));
			try {
				const analyses: PageAnalysis[] = [];
				let ocrPageCount = 0;
				let stoppedEarly = false;

				for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
					const page = await pdf.getPage(pageNumber);
					try {
						const analysis = await analyzePage(page, pageNumber);
						analyses.push(analysis);
						if (analysis.recommendedMode === 'ocr') ocrPageCount++;
						if (stopAfterOcrPages > 0 && ocrPageCount >= stopAfterOcrPages && pageNumber < pdf.numPages) {
							stoppedEarly = true;
							break;
						}
					} finally {
						page.cleanup();
					}
				}

				const nativePageCount = analyses.length - ocrPageCount;
				const modes = new Set(analyses.map((page) => page.recommendedMode));
				const recommendedMode = stoppedEarly
					? 'auto'
					: modes.size === 1
						? analyses[0]?.recommendedMode ?? 'auto'
						: 'auto';

				output.push({
					json: {
						...(items[itemIndex].json as IDataObject),
						pageCount: pdf.numPages,
						recommendedMode,
						nativePageCount,
						ocrPageCount,
						analyzedPageCount: analyses.length,
						analysisComplete: !stoppedEarly,
						ocrThresholdExceeded: stoppedEarly,
						pages: analyses.map((page) => ({
							page: page.page,
							recommendedMode: page.recommendedMode,
							wordCount: page.wordCount,
							imageCoverage: Number(page.imageCoverage.toFixed(4)),
						})),
					} as IDataObject,
					pairedItem: { item: itemIndex },
				});
			} finally {
				await pdf.destroy();
			}
		}

		return [output];
	}
}
