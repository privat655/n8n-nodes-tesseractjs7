import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

export type PercentageRegion = { x: number; y: number; width: number; height: number };
export type PageDimensions = { width: number; height: number; fullWidth: number; fullHeight: number };
type JobBase = { id: number; page: number; dpi: number; region?: PercentageRegion; reject: (error: Error) => void };
type Job = JobBase & (
	| { type: 'render'; resolve: (value: Buffer) => void }
	| { type: 'inspect'; resolve: (value: PageDimensions) => void }
);
type WorkerResponse =
	| { type: 'ready'; pageCount: number }
	| { type: 'result'; id: number; page: number; png: Uint8Array }
	| { type: 'dimensions'; id: number; page: number; width: number; height: number; fullWidth: number; fullHeight: number }
	| { type: 'error'; id: number; page: number; message: string };
type WorkerState = { worker: Worker; ready: boolean; current?: Job };

export class IsolatedPdfRenderer {
	private readonly states: WorkerState[] = [];
	private readonly queue: Job[] = [];
	private nextId = 1;
	private closed = false;
	private sourcePageCount = 0;
	private constructor() {}

	get pageCount(): number { return this.sourcePageCount; }

	static async create(pdf: Buffer, workerCount: number): Promise<IsolatedPdfRenderer> {
		if (!Number.isInteger(workerCount) || workerCount < 1) {
			throw new Error('PDF renderer worker count must be a positive integer');
		}
		const sharedPdf = new SharedArrayBuffer(pdf.length);
		new Uint8Array(sharedPdf).set(pdf);
		const renderer = new IsolatedPdfRenderer();
		try {
			await Promise.all(Array.from({ length: workerCount }, async () => renderer.addWorker(sharedPdf)));
			return renderer;
		} catch (error) {
			await renderer.terminate();
			throw error;
		}
	}

	render(page: number, dpi: number, region?: PercentageRegion): Promise<Buffer> {
		if (this.closed) return Promise.reject(new Error('PDF renderer is closed'));
		return new Promise<Buffer>((resolve, reject) => {
			this.queue.push({ type: 'render', id: this.nextId++, page, dpi, region, resolve, reject });
			this.dispatch();
		});
	}

	inspect(page: number, dpi: number, region?: PercentageRegion): Promise<PageDimensions> {
		if (this.closed) return Promise.reject(new Error('PDF renderer is closed'));
		return new Promise<PageDimensions>((resolve, reject) => {
			this.queue.push({ type: 'inspect', id: this.nextId++, page, dpi, region, resolve, reject });
			this.dispatch();
		});
	}

	async terminate(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const error = new Error('PDF renderer terminated');
		for (const job of this.queue.splice(0)) job.reject(error);
		await Promise.all(this.states.map(async (state) => {
			if (state.current || !state.ready) {
				state.current?.reject(error);
				await state.worker.terminate();
				return;
			}
			// Let PDF.js dispose its document before an idle native canvas isolate exits.
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => { void state.worker.terminate().then(() => resolve()); }, 1000);
				state.worker.once('exit', () => { clearTimeout(timer); resolve(); });
				state.worker.postMessage({ type: 'shutdown' });
			});
		}));
	}

	private async addWorker(pdfData: SharedArrayBuffer): Promise<void> {
		const worker = new Worker(join(__dirname, 'pdf-render.worker.js'), { workerData: { pdfData } });
		const state: WorkerState = { worker, ready: false };
		this.states.push(state);
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const failStartup = (error: Error) => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			worker.on('message', (message: WorkerResponse) => {
				if (message.type === 'ready') {
					if (!settled) {
						settled = true;
						this.sourcePageCount = message.pageCount;
						state.ready = true;
						resolve();
						this.dispatch();
					}
					return;
				}
				this.handleResponse(state, message);
			});
			worker.on('error', (error) => { failStartup(error); this.failAll(error); });
			worker.on('exit', (code) => {
				if (!this.closed) {
					const error = new Error(`PDF renderer worker exited unexpectedly with code ${code}`);
					failStartup(error);
					this.failAll(error);
				}
			});
		});
	}

	private handleResponse(state: WorkerState, message: Exclude<WorkerResponse, { type: 'ready' }>): void {
		const job = state.current;
		state.current = undefined;
		if (!job || job.id !== message.id) {
			this.failAll(new Error(`PDF renderer returned an unexpected response for page ${message.page}`));
			return;
		}
		if (message.type === 'result' && job.type === 'render') job.resolve(Buffer.from(message.png));
		else if (message.type === 'dimensions' && job.type === 'inspect') {
			job.resolve({ width: message.width, height: message.height, fullWidth: message.fullWidth, fullHeight: message.fullHeight });
		}
		else if (message.type === 'error') job.reject(new Error(`PDF page ${message.page}: ${message.message}`));
		else job.reject(new Error(`Unexpected PDF renderer response type for page ${message.page}`));
		this.dispatch();
	}

	private dispatch(): void {
		if (this.closed) return;
		for (const state of this.states) {
			if (!state.ready || state.current || this.queue.length === 0) continue;
			const job = this.queue.shift();
			if (!job) return;
			state.current = job;
			state.worker.postMessage({ id: job.id, type: job.type, page: job.page, dpi: job.dpi, region: job.region });
		}
	}

	private failAll(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const job of this.queue.splice(0)) job.reject(error);
		for (const state of this.states) {
			state.current?.reject(error);
			state.current = undefined;
			void state.worker.terminate();
		}
	}
}
