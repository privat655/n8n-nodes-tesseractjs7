import {
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeConnectionType,
	NodeOperationError,
} from 'n8n-workflow';
import { slicePdfBuffer } from '../shared/pdfSlice';

export class PdfPageSlice implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'PDF Page Slice',
		name: 'pdfPageSlice',
		icon: 'file:tesseract.svg',
		group: ['transform'],
		version: 1,
		description: 'Create one lightweight PDF containing an inclusive page range',
		defaults: { name: 'PDF Page Slice' },
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
				description: 'Name of the binary field containing the source PDF',
			},
			{
				displayName: 'Output PDF Field',
				name: 'outputDataFieldName',
				type: 'string',
				default: 'data',
				description: 'Binary field that will contain only the sliced PDF',
			},
			{
				displayName: 'Page From',
				name: 'pageFrom',
				type: 'number',
				default: 1,
				typeOptions: { minValue: 1, numberPrecision: 0 },
				description: 'First page to include, using 1-based numbering',
			},
			{
				displayName: 'Page To',
				name: 'pageTo',
				type: 'number',
				default: 1,
				typeOptions: { minValue: 1, numberPrecision: 0 },
				description: 'Last page to include, using 1-based numbering',
			},
			{
				displayName: 'Max Output Bytes',
				name: 'maxOutputBytes',
				type: 'number',
				default: 0,
				typeOptions: { minValue: 0, numberPrecision: 0 },
				description: 'Optional hard limit for the generated PDF in bytes; 0 disables the check',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const inputField = this.getNodeParameter('inputDataFieldName', itemIndex, 'data') as string;
			const outputField = this.getNodeParameter('outputDataFieldName', itemIndex, 'data') as string;
			const pageFrom = this.getNodeParameter('pageFrom', itemIndex, 1) as number;
			const pageTo = this.getNodeParameter('pageTo', itemIndex, 1) as number;
			const maxOutputBytes = this.getNodeParameter('maxOutputBytes', itemIndex, 0) as number;
			const inputBinary = items[itemIndex].binary?.[inputField];

			if (!inputBinary) {
				throw new NodeOperationError(this.getNode(), `Binary field "${inputField}" is missing`, { itemIndex });
			}

			try {
				const sourceBuffer = await this.helpers.getBinaryDataBuffer(itemIndex, inputField);
				const result = await slicePdfBuffer(sourceBuffer, pageFrom, pageTo);
				const outputBuffer = Buffer.from(result.bytes);

				if (maxOutputBytes > 0 && outputBuffer.length > maxOutputBytes) {
					throw new NodeOperationError(
						this.getNode(),
						`Generated PDF slice is ${outputBuffer.length} bytes and exceeds Max Output Bytes (${maxOutputBytes})`,
						{ itemIndex },
					);
				}

				const sourceName = inputBinary.fileName || 'document.pdf';
				const baseName = sourceName.toLowerCase().endsWith('.pdf') ? sourceName.slice(0, -4) : sourceName;
				const fileName = `${baseName}-pages-${pageFrom}-${pageTo}.pdf`;
				const binary = await this.helpers.prepareBinaryData(outputBuffer, fileName, 'application/pdf');

				output.push({
					json: {
						...(items[itemIndex].json as IDataObject),
						pdf_slice_page_from: pageFrom,
						pdf_slice_page_to: pageTo,
						pdf_slice_page_count: pageTo - pageFrom + 1,
						pdf_source_page_count: result.pageCount,
						pdf_slice_size_bytes: outputBuffer.length,
					} as IDataObject,
					binary: { [outputField]: binary },
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (error instanceof NodeOperationError) throw error;
				throw new NodeOperationError(
					this.getNode(),
					`Failed to slice PDF pages ${pageFrom}-${pageTo}: ${error instanceof Error ? error.message : String(error)}`,
					{ itemIndex },
				);
			}
		}

		return [output];
	}
}
