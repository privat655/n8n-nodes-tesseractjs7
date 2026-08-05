# n8n-nodes-tesseractjs7

Two n8n community nodes for extracting text from PDF documents.

## PDF Recognition Preflight

The preflight node inspects every page without running OCR. It returns the document page count, a top-level recommendation and one recommendation per page. The original PDF binary is passed through unchanged.

```json
{
  "pageCount": 4,
  "recommendedMode": "auto",
  "pages": [
    { "page": 1, "recommendedMode": "native", "wordCount": 221, "imageCoverage": 0.0158 },
    { "page": 4, "recommendedMode": "ocr", "wordCount": 0, "imageCoverage": 1 }
  ]
}
```

A page is recommended for OCR when its native text layer is clearly broken, contains no valid printable character, contains no words while raster images cover more than 20% of the page, or when raster images cover at least 80% and fewer than 20 native words are present. A page with sufficient native text remains native even when it also contains a large image.

The top-level recommendation is `native` or `ocr` when every page agrees, and `auto` for mixed documents.

## PDF Text Recognition

The recognition node supports three modes:

- **Auto** chooses native text or OCR separately for each selected page.
- **Native Text** forces native extraction for all selected pages.
- **OCR** forces OCR for all selected pages.

Pages can be selected either as an inclusive range or as a comma-separated list such as `1,5,6`. The two input styles are mutually exclusive in the node interface. OCR pages are processed with up to three Tesseract workers in parallel.

Range output:

```json
{
  "source": "mixed",
  "pageCount": 4,
  "range": { "from": 1, "to": 4 },
  "pages": [
    { "page": 1, "source": "native", "text": "Native PDF text" },
    { "page": 4, "source": "ocr", "text": "Recognized image text", "confidence": 95.2 }
  ]
}
```

Specific-page output:

```json
{
  "source": "ocr",
  "pageCount": 10,
  "selectedPages": [1, 5, 6],
  "pages": [
    { "page": 1, "source": "ocr", "text": "Recognized text", "confidence": 94.1 }
  ]
}
```

## Parameters

### Preflight

- **Input PDF Field**: binary property containing the PDF, default `data`

### Recognition

- **Input PDF Field**: binary property containing the PDF, default `data`
- **Recognition Mode**: `Auto`, `Native Text` or `OCR`
- **Page Selection**: `Range` or `Specific Pages`
- **Page From**: first page in range mode, default `1`
- **Page To**: last page in range mode, default `0` for the document end
- **Pages**: comma-separated page numbers in specific-pages mode, for example `1,5,6`
- **Language**: Tesseract language code, default `deu`
- **DPI**: OCR render resolution, default `300`
- **OCR Timeout**: maximum OCR time per page, default `120000` ms

## Behavior

- PDF input only
- One output item per input PDF
- Page results remain ordered
- German (`deu`) is the default OCR language
- OCR uses Tesseract LSTM, automatic page segmentation and preserved inter-word spaces
- No file-size limit, image input, binary OCR output or automatic DPI fallback

## Development

```bash
npm ci
npm test
npm run lint
```
