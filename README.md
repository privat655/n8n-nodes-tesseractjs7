# n8n-nodes-tesseractjs7

Two n8n community nodes for PDF text recognition.

## PDF Recognition Preflight

Inspects the complete PDF without OCR and returns:

```json
{
  "pageCount": 30,
  "recommendedMode": "ocr"
}
```

The input binary is passed through unchanged. `recommendedMode` is either `native` or `ocr` and can be mapped directly into the recognition node.

## PDF Text Recognition

Processes the complete PDF or an inclusive page range. It returns one item with ordered pages:

```json
{
  "source": "ocr",
  "pageCount": 30,
  "range": { "from": 11, "to": 20 },
  "pages": [
    { "page": 11, "text": "Recognized text", "confidence": 96.2 }
  ]
}
```

### Parameters

- **Input PDF Field**: binary property containing the PDF, default `data`
- **Recognition Mode**: `Auto`, `Native Text`, or `OCR`
- **Page From**: first page, default `1`
- **Page To**: last page; `0` means the final page
- **Language**: Tesseract language code, default `deu`
- **DPI**: OCR render resolution, default `300`
- **OCR Timeout**: maximum OCR time per page, default `120000` ms

OCR uses up to three Tesseract workers and processes at most three rendered pages at once. Results remain sorted by PDF page number.

## Chunked workflow

Run the preflight once, create ranges such as `1-10`, `11-20`, and `21-30`, and process those range items sequentially. Set **Recognition Mode** from `recommendedMode` so every chunk uses the same document-wide decision.

## Behavior

- PDF input only
- One output item per PDF or selected range
- German (`deu`) is the default OCR language
- OCR uses Tesseract LSTM, automatic page segmentation, and preserved inter-word spaces
- No file-size limit or automatic DPI fallback

## Development

```bash
npm ci
npm test
npm run lint
```
