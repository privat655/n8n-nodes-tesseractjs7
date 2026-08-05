const LARGE_IMAGE_COVERAGE = 0.8;
const RELEVANT_IMAGE_COVERAGE = 0.2;
const MIN_NATIVE_WORDS_ON_IMAGE_PAGE = 20;
const MAX_INVALID_CHARACTER_RATIO = 0.01;
const MIN_TEXT_FOR_INVALIDITY_CHECK = 20;

function count(text: string, pattern: RegExp): number {
	return text.match(pattern)?.length ?? 0;
}

export function countWords(text: string): number {
	return count(text, /[\p{L}\p{N}]+(?:[.'’/-][\p{L}\p{N}]+)*/gu);
}

export function recommendPageMode(text: string, imageCoverage: number): 'native' | 'ocr' {
	const meaningfulCharacters = count(text, /[\p{L}\p{N}]/gu);
	const validCharacters = count(text, /[^\s\u0000-\u001F\u007F\uFFFD]/gu);
	const invalidCharacters = count(text, /\uFFFD|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g);
	const invalidCharacterRatio = invalidCharacters / Math.max(text.length, 1);
	const wordCount = countWords(text);
	const textIsBroken =
		meaningfulCharacters >= MIN_TEXT_FOR_INVALIDITY_CHECK &&
		invalidCharacterRatio > MAX_INVALID_CHARACTER_RATIO;
	const hasNoValidCharacters = validCharacters === 0;
	const noWordsWithRelevantImage = wordCount === 0 && imageCoverage > RELEVANT_IMAGE_COVERAGE;
	const looksLikeScannedPage =
		imageCoverage >= LARGE_IMAGE_COVERAGE && wordCount < MIN_NATIVE_WORDS_ON_IMAGE_PAGE;

	return textIsBroken || hasNoValidCharacters || noWordsWithRelevantImage || looksLikeScannedPage
		? 'ocr'
		: 'native';
}
