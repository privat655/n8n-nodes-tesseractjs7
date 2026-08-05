import {
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeConnectionType,
	NodeOperationError,
} from 'n8n-workflow';
import { extractNativePages, loadPdf } from '../shared/pdf';
import { hasUsableNativeText } from '../shared/quality';

export class PdfRecognitionPreflight implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'PDF Recognition Preflight',
		name: 'pdfRecognitionPreflight',
		icon: 'file:tesseract.svg',
		group: ['transform'],
		version: 1,
		description: 'Inspect a PDF and recommend native text extraction or OCR',
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

			const pdf = await loadPdf(await this.helpers.getBinaryDataBuffer(itemIndex, field));
			try {
				const pageNumbers = Array.from({ length: pdf.numPages }, (_, index) => index + 1);
				const pages = await extractNativePages(pdf, pageNumbers);
				output.push({
					json: {
						pageCount: pdf.numPages,
						recommendedMode: hasUsableNativeText(pages) ? 'native' : 'ocr',
					} as IDataObject,
					binary: items[itemIndex].binary,
					pairedItem: { item: itemIndex },
				});
			} finally {
				await pdf.destroy();
			}
		}

		return [output];
	}
}
