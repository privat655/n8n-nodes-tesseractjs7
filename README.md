# n8n-nodes-tesseractjs7

Three n8n community nodes for PDF inspection, extraction/OCR, and lightweight page slicing.

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

## PDF Page Slice

The slice node creates one standalone PDF containing exactly one inclusive page range from the input PDF. It is intentionally small and deterministic so it can be placed behind an n8n `Loop Over Items` node with batch size `1` for memory-safe sequential processing of large PDFs.

It does not render pages, run OCR, create arrays of PDF parts, or keep the original PDF as an additional output binary. The configured output binary field contains only the sliced PDF.

Example for a Mistral-style sequential worker:

```text
large PDF
  -> plan page ranges
  -> Loop Over Items (batch size 1)
  -> PDF Page Slice
  -> OCR/API call
  -> discard part binary
  -> next range
```

The node adds only small JSON metadata:

```json
{
  "pdf_slice_page_from": 1,
  "pdf_slice_page_to": 10,
  "pdf_slice_page_count": 10,
  "pdf_source_page_count": 87,
  "pdf_slice_size_bytes": 1234567
}
```

`Max Output Bytes` can be used as a hard safety check for API upload limits. The node fails rather than forwarding an oversized part.

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

### Page Slice

- **Input PDF Field**: binary property containing the source PDF, default `data`
- **Output PDF Field**: binary property that will contain the sliced PDF, default `data`
- **Page From**: first page to include, 1-based and inclusive
- **Page To**: last page to include, 1-based and inclusive
- **Max Output Bytes**: optional hard size limit; `0` disables the check

## Behavior

- PDF input only
- One output item per input PDF
- Page results remain ordered
- German (`deu`) is the default OCR language
- OCR uses Tesseract LSTM, automatic page segmentation and preserved inter-word spaces
- Page Slice copies selected PDF pages without rendering and returns only the sliced binary
- No automatic fan-out of PDF parts; sequential batching remains under workflow control

## Development

```bash
npm ci
npm test
npm run lint
```
