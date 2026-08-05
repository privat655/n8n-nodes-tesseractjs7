import { parentPort, workerData } from 'node:worker_threads';

type RenderRequest = {
	id: number;
	type: 'render';
	page: number;
	dpi: number;
};

type ShutdownRequest = { type: 'shutdown' };

type WorkerInput = RenderRequest | ShutdownRequest;

type PdfCanvas = {
	width: number;
	height: number;
	getContext(type: '2d', options?: { willReadFrequently?: boolean }): CanvasRenderingContext2D;
	toBuffer(type: 'image/png'): Buffer;
};

type CanvasEntry = {
	canvas: PdfCanvas | null;
	context: CanvasRenderingContext2D | null;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function start(): Promise<void> {
	const port = parentPort;
	if (!port) throw new Error('PDF renderer worker requires a parent port');

	const canvas = await import('@napi-rs/canvas');
	globalThis.DOMMatrix = canvas.DOMMatrix as unknown as typeof DOMMatrix;
	globalThis.ImageData = canvas.ImageData as unknown as typeof ImageData;
	globalThis.Path2D = canvas.Path2D as unknown as typeof Path2D;

	const compatibilityCanvas = canvas.createCanvas(2, 2);
	const compatibilityContext = compatibilityCanvas.getContext('2d');
	const compatibilityPath = new canvas.Path2D();
	compatibilityPath.rect(0, 0, 1, 1);
	compatibilityContext.fill(compatibilityPath);

	class WorkerCanvasFactory {
		create(width: number, height: number): CanvasEntry {
			const created = canvas.createCanvas(width, height) as unknown as PdfCanvas;
			return {
				canvas: created,
				context: created.getContext('2d', { willReadFrequently: true }),
			};
		}

		reset(entry: CanvasEntry, width: number, height: number): void {
			if (!entry.canvas) throw new Error('Canvas is not specified');
			entry.canvas.width = width;
			entry.canvas.height = height;
		}

		destroy(entry: CanvasEntry): void {
			if (!entry.canvas) return;
			entry.canvas.width = 0;
			entry.canvas.height = 0;
			entry.canvas = null;
			entry.context = null;
		}
	}

	const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
		getDocument(options: unknown): { promise: Promise<any> };
	};
	const sharedPdf = (workerData as { pdfData: SharedArrayBuffer }).pdfData;
	const pdf = await pdfjs.getDocument({
		data: new Uint8Array(sharedPdf),
		useSystemFonts: true,
		CanvasFactory: WorkerCanvasFactory,
	}).promise;

	port.postMessage({ type: 'ready' });
	port.on('message', async (message: WorkerInput) => {
		if (message.type === 'shutdown') {
			await pdf.destroy();
			port.close();
			return;
		}

		const page = await pdf.getPage(message.page);
		let entry: CanvasEntry | undefined;
		try {
			const viewport = page.getViewport({ scale: message.dpi / 72 });
			const createdEntry = pdf.canvasFactory.create(
				Math.ceil(viewport.width),
				Math.ceil(viewport.height),
			) as CanvasEntry;
			entry = createdEntry;
			const { canvas: renderedCanvas, context } = createdEntry;
			if (!renderedCanvas || !context) throw new Error('PDF.js did not create a canvas');
			await page.render({
				canvasContext: context,
				viewport,
				background: '#ffffff',
			}).promise;
			const png = Uint8Array.from(renderedCanvas.toBuffer('image/png'));
			port.postMessage(
				{ type: 'result', id: message.id, page: message.page, png },
				[png.buffer],
			);
		} catch (error) {
			port.postMessage({
				type: 'error',
				id: message.id,
				page: message.page,
				message: errorMessage(error),
			});
		} finally {
			if (entry) pdf.canvasFactory.destroy(entry);
			page.cleanup();
		}
	});
}

void start().catch((error) => {
	throw error;
});
