import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

type RenderRequest = {
	id: number;
	type: 'render';
	page: number;
	dpi: number;
};

type WorkerResponse =
	| { type: 'ready' }
	| { type: 'result'; id: number; page: number; png: Uint8Array }
	| { type: 'error'; id: number; page: number; message: string };

type RenderJob = {
	id: number;
	page: number;
	dpi: number;
	resolve: (value: Buffer) => void;
	reject: (error: Error) => void;
};

type WorkerState = {
	worker: Worker;
	ready: boolean;
	current?: RenderJob;
};

export class IsolatedPdfRenderer {
	private readonly states: WorkerState[] = [];
	private readonly queue: RenderJob[] = [];
	private nextId = 1;
	private closed = false;

	private constructor() {}

	static async create(pdf: Buffer, workerCount: number): Promise<IsolatedPdfRenderer> {
		if (!Number.isInteger(workerCount) || workerCount < 1) {
			throw new Error('PDF renderer worker count must be a positive integer');
		}

		const sharedPdf = new SharedArrayBuffer(pdf.length);
		new Uint8Array(sharedPdf).set(pdf);
		const renderer = new IsolatedPdfRenderer();
		await Promise.all(
			Array.from({ length: workerCount }, async () => renderer.addWorker(sharedPdf)),
		);
		return renderer;
	}

	render(page: number, dpi: number): Promise<Buffer> {
		if (this.closed) return Promise.reject(new Error('PDF renderer is closed'));

		return new Promise<Buffer>((resolve, reject) => {
			this.queue.push({ id: this.nextId++, page, dpi, resolve, reject });
			this.dispatch();
		});
	}

	async terminate(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const error = new Error('PDF renderer terminated');
		for (const job of this.queue.splice(0)) job.reject(error);
		for (const state of this.states) state.current?.reject(error);
		await Promise.all(this.states.map(async ({ worker }) => worker.terminate()));
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
						state.ready = true;
						resolve();
						this.dispatch();
					}
					return;
				}
				this.handleResponse(state, message);
			});
			worker.on('error', (error) => {
				failStartup(error);
				this.failAll(error);
			});
			worker.on('exit', (code) => {
				if (!this.closed && code !== 0) {
					const error = new Error(`PDF renderer worker exited with code ${code}`);
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

		if (message.type === 'result') {
			job.resolve(Buffer.from(message.png));
		} else {
			job.reject(new Error(`Failed to render PDF page ${message.page} in isolated renderer: ${message.message}`));
		}
		this.dispatch();
	}

	private dispatch(): void {
		if (this.closed) return;
		for (const state of this.states) {
			if (!state.ready || state.current || this.queue.length === 0) continue;
			const job = this.queue.shift();
			if (!job) return;
			state.current = job;
			const request: RenderRequest = { id: job.id, type: 'render', page: job.page, dpi: job.dpi };
			state.worker.postMessage(request);
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
