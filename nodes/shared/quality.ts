const MIN_MEANINGFUL_CHARACTERS_PER_PAGE = 100;
const MIN_BODY_PAGE_CHARACTERS = 300;
const MAX_INVALID_CHARACTER_RATIO = 0.01;

function count(text: string, pattern: RegExp): number {
	return text.match(pattern)?.length ?? 0;
}

export function hasUsableNativeText(pages: string[]): boolean {
	if (pages.length === 0) return false;

	const meaningful = pages.map((text) => count(text, /[\p{L}\p{N}]/gu));
	const allText = pages.join('');
	const invalid = count(allText, /\uFFFD|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g);

	return (
		meaningful.reduce((sum, value) => sum + value, 0) >=
			pages.length * MIN_MEANINGFUL_CHARACTERS_PER_PAGE &&
		meaningful.filter((value) => value >= MIN_BODY_PAGE_CHARACTERS).length >=
			Math.ceil(pages.length / 4) &&
		invalid / Math.max(allText.length, 1) <= MAX_INVALID_CHARACTER_RATIO
	);
}
