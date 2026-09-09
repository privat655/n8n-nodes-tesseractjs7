/** Select physical PDF pages without changing the legacy page-range parsers. */
export function selectPdfPages(pageCount: number, selection: string, maxPages = 100): number[] {
	if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error('PDF page count must be a positive safe integer');
	if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('Max Pages must be a positive safe integer');
	if (typeof selection !== 'string' || selection.length > 4096) throw new Error('Pages must be a string of at most 4096 characters');
	const value = selection.trim();
	const ranges: Array<[number, number]> = [];
	if (value === '' || value === '*') {
		ranges.push([1, pageCount]);
	} else {
		for (const token of value.split(',')) {
			const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token.trim());
			if (!match) throw new Error('Pages must be empty, *, or comma-separated pages/ranges such as 1,3-5,15');
			const start = Number(match[1]);
			const end = Number(match[2] ?? match[1]);
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
				throw new Error('Page ranges must contain positive safe integers in ascending order');
			}
			if (end > pageCount) throw new Error(`Page ${end} exceeds the PDF page count (${pageCount})`);
			ranges.push([start, end]);
		}
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const [start, end] of ranges) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	// Check the union before expanding ranges; a huge range cannot allocate a huge array.
	const count = merged.reduce((sum, [start, end]) => sum + end - start + 1, 0);
	if (count > maxPages) throw new Error(`Selected ${count} pages; Max Pages is ${maxPages}. Select fewer pages or raise the limit`);
	return merged.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, index) => start + index));
}
