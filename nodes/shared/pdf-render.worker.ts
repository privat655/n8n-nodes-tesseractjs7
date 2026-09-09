import { parentPort, workerData } from 'node:worker_threads';

type PageRequest = { id: number; type: 'render' | 'inspect'; page: number; dpi: number };
type WorkerInput = PageRequest | { type: 'shutdown' };
type PdfCanvas = {
	width: number; height: number;
	getContext(type: '2d', options?: { willReadFrequently?: boolean }): CanvasRenderingContext2D;
	toBuffer(type: 'image/png'): Buffer;
};
type CanvasEntry = { canvas: PdfCanvas | null; context: CanvasRenderingContext2D | null };

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

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
			return { canvas: created, context: created.getContext('2d', { willReadFrequently: true }) };
		}
		reset(entry: CanvasEntry, width: number, height: number): void {
			if (!entry.canvas) throw new Error('Canvas is not specified');
			// Avoid mutating native canvas width/height. @napi-rs/canvas 0.1.79 has a known
			// external-memory accounting bug in those resize setters that can fatally abort V8.
			// PDF.js can invoke reset for temporary image/mask canvases, so replace the backing
			// canvas and context atomically instead of resizing the existing native surface.
			const replacement = this.create(width, height);
			entry.context = replacement.context;
			entry.canvas = replacement.canvas;
		}
		destroy(entry: CanvasEntry): void {
			// Release references without resizing a native surface to zero twice.
			entry.context = null;
			entry.canvas = null;
		}
	}

	const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
		getDocument(options: unknown): { promise: Promise<any> };
	};
	const sharedPdf = (workerData as { pdfData: SharedArrayBuffer }).pdfData;
	const localPdf = Uint8Array.from(new Uint8Array(sharedPdf));
	const pdf = await pdfjs.getDocument({ data: localPdf, useSystemFonts: true, CanvasFactory: WorkerCanvasFactory }).promise;
	port.postMessage({ type: 'ready', pageCount: pdf.numPages });
	port.on('message', async (message: WorkerInput) => {
		if (message.type === 'shutdown') {
			await pdf.destroy();
			port.close();
			return;
		}
		let page: any;
		let entry: CanvasEntry | undefined;
		try {
			page = await pdf.getPage(message.page);
			const viewport = page.getViewport({ scale: message.dpi / 72 });
			const width = Math.ceil(viewport.width);
			const height = Math.ceil(viewport.height);
			if (message.type === 'inspect') {
				port.postMessage({ type: 'dimensions', id: message.id, page: message.page, width, height });
				return;
			}
			entry = pdf.canvasFactory.create(width, height) as CanvasEntry;
			const { canvas: renderedCanvas, context } = entry;
			if (!renderedCanvas || !context) throw new Error('PDF.js did not create a canvas');
			await page.render({ canvasContext: context, viewport, background: '#ffffff' }).promise;
			const png = Uint8Array.from(renderedCanvas.toBuffer('image/png'));
			// Copy the payload; do not transfer backing-store ownership across isolate teardown.
			port.postMessage({ type: 'result', id: message.id, page: message.page, png });
		} catch (error) {
			port.postMessage({ type: 'error', id: message.id, page: message.page, message: errorMessage(error) });
		} finally {
			if (entry) pdf.canvasFactory.destroy(entry);
			page?.cleanup();
		}
	});
}
void start().catch((error) => { throw error; });
