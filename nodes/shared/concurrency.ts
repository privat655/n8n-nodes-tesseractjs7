export async function mapLimit<T, R>(
	values: T[],
	limit: number,
	mapper: (value: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let nextIndex = 0;

	await Promise.all(
		Array.from({ length: Math.min(limit, values.length) }, async () => {
			while (nextIndex < values.length) {
				const index = nextIndex++;
				results[index] = await mapper(values[index]);
			}
		}),
	);

	return results;
}
