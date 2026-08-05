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

A page is recommended for OCR when its native text layer is clearly broken, or when raster images cover at least 80% of the page and fewer than 20 native words are present. Small logos do not trigger OCR. A page with a full native text layer remains native even when it also contains a large image.

The top-level recommendation is `native` or `ocr` when every page agrees, and `auto` for mixed documents.

## PDF Text Recognition

The recognition node supports three modes:

- **Auto** chooses native text or OCR separately for each selected page.
- **Native Text** forces native extraction for the complete selected range.
- **OCR** forces OCR for the complete selected range.

OCR pages are processed with up to three Tesseract workers in parallel. `Page From` and `Page To` select an inclusive range; `Page To = 0` means the final page.

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

## Parameters

### Preflight

- **Input PDF Field**: binary property containing the PDF, default `data`

### Recognition

- **Input PDF Field**: binary property containing the PDF, default `data`
- **Recognition Mode**: `Auto`, `Native Text` or `OCR`
- **Page From**: first page, default `1`
- **Page To**: last page, default `0` for the document end
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
