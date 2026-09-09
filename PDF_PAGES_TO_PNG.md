# PDF Pages to PNG

`n8n-nodes-tesseractjs7.pdfPagesToPng` is a separate transform node. It does not run OCR or call an external model. The existing recognition, preflight, and page-slice nodes are unchanged.

## Input and page selection

Connect a PDF binary item, for example the output of an HTTP Request node with Response Format **File**. The default input binary field is `data`.

`pages` accepts empty text or `*` for all physical PDF pages, single pages (`1,3`), inclusive ranges (`1-3`), and mixtures (`1,3-5,15`). Numbering starts at 1 and does not refer to printed page labels. Whitespace around tokens and hyphens is allowed. Duplicate or overlapping selections are deduplicated and returned in ascending page order. Invalid syntax, reversed ranges, and out-of-range pages fail the input; they never mean all pages.

## Output

Each selected page becomes one output item. The default PNG binary field is `data`; its MIME type is `image/png`. Input JSON is preserved, followed by authoritative metadata:

- `pdf_page_number`, `pdf_source_page_count`, `pdf_selected_page_count`
- `pdf_render_dpi`, `pdf_width`, `pdf_height`, `pdf_png_size_bytes`
- `pdf_source_file_name`

Each output contains `pairedItem` pointing to the source input. The source PDF and other input binary fields are not copied into the page outputs. Image bytes are passed through `getBinaryDataBuffer` and `prepareBinaryData`, not placed in JSON or manually base64-encoded. n8n remains responsible for its internal binary storage representation.

## Send a PNG with HTTP Request

For a destination that actually accepts multipart uploads, use **Body Content Type: Form-Data**. Add a parameter of type **n8n Binary File**, set its input binary field to `data`, and set the form field name required by that destination. Add any prompt or model parameters according to the destination's documented contract. Do not manually set the multipart Content-Type header because the HTTP node supplies its boundary.

Binary node output does not imply that a model endpoint accepts multipart requests. An endpoint requiring image URLs or JSON image content needs a separate upload/adapter step. This node intentionally contains no provider-specific transport.

For bounded request concurrency without a Code node, feed the page items through **Loop Over Items**, with the desired batch size, then HTTP Request and response normalization back into the loop. Aggregate only from the loop's **done** output. The HTTP node's interval-based batching is not a hard maximum of in-flight requests.

## Limits and memory

Defaults: 150 DPI; 50 MiB input; 100 selected pages; 25 million pixels per page; 128 MiB total output PNG bytes per PDF; 60 seconds per render call after renderer startup. DPI is restricted to 36-600. The maximum raster edge is 32767 pixels.

The full selection and all page raster dimensions are checked before rendering. Oversized drawings fail with a request to reduce DPI rather than silently changing resolution. A single isolated renderer worker renders pages sequentially. Each PNG is stored through n8n's binary helper immediately. In-memory binary mode still retains encoded output; configure the appropriate supported binary backend for the deployment. This is not a streaming node: downstream nodes receive output after rendering completes.

Parsing and renderer startup use the existing PDF implementations; the per-page timeout is not a process-wide execution deadline. Configure workflow/caller execution timeouts separately.

Errors fail the input PDF. With Continue On Fail enabled, an error item without binary is returned instead; successfully generated pages from that failed PDF are not emitted as a seemingly complete result. Temporary binary objects already prepared before a later failure follow n8n's normal execution retention/pruning.

## Verification and release

Run `npm test` and `npm run lint`. Tests cover mixed selections, deduplication, limit-before-expansion, actual PNG generation, rotated dimensions, storage helper use, binary-only image output, provenance, multiple inputs, and failures.

Merge and publish a new package version through the repository's normal release process before configuring production workflows to use the new node. This change does not publish a package or deploy an n8n installation.
