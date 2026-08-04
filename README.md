# n8n-nodes-tesseractjs7

An n8n community node for extracting text from PDF documents.

The node first reads the native text layer of every page. It uses that text only when the complete document contains enough meaningful text and no明显 broken Unicode layer. Otherwise it renders every page at the configured DPI and recognizes the complete document with Tesseract.js.

## Behavior

- PDF input only
- One output item per PDF
- One document-wide decision: `native` or `ocr`
- Pages remain ordered in `json.pages`
- German (`deu`) is the default OCR language
- OCR uses Tesseract LSTM, automatic page segmentation and preserved inter-word spaces
- No file-size limit, image input, binary output, box extraction or automatic DPI fallback

## Output

```json
{
  "source": "ocr",
  "pages": [
    {
      "page": 1,
      "text": "Recognized text",
      "confidence": 96.2
    }
  ]
}
```

Native PDFs use the same structure without `confidence`.

## Parameters

- **Input PDF Field**: binary property containing the PDF, default `data`
- **Language**: Tesseract language code, default `deu`
- **DPI**: render resolution used when OCR is required, default `300`
- **OCR Timeout**: maximum OCR time per page, default `120000` ms

## Development

```bash
npm install
npm test
npm run lint
```

## Version 2

Version 2 is a breaking simplification. It removes image input, bounding boxes, per-image PDF extraction, binary OCR output, confidence filtering and PDF file-size limits.
