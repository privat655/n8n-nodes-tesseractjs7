# PDF Pages to PNG

`n8n-nodes-tesseractjs7.pdfPagesToPng` is a separate transform node. It does not run OCR or call an external model. Existing node interfaces and legacy page-selection semantics remain unchanged. The shared renderer gains page inspection and safer native-canvas cleanup.

## Input and selection

Connect a PDF binary item, for example HTTP Request with Response Format **File**. The default input field is `data`.

`pages` accepts empty text or `*` for all physical PDF pages, single pages (`1,3`), inclusive ranges (`1-3`), and mixtures (`1,3-5,15`). Numbering starts at 1, not at printed page labels. Whitespace around tokens and hyphens is allowed. Duplicates and overlaps are deduplicated; output is in ascending order. Invalid syntax, reversed ranges, and out-of-range pages fail the input; they never mean all pages.

## Native binary output

One item per selected page; default output binary field `data`, MIME type `image/png`. JSON contains the original input fields plus:

- `pdf_page_number`, `pdf_source_page_count`, `pdf_selected_page_count`
- `pdf_render_dpi`, `pdf_width`, `pdf_height`, `pdf_png_size_bytes`
- `pdf_source_file_name`

Each page has `pairedItem` pointing to its source input. Other input binaries, including the PDF, are not copied. Image bytes use `getBinaryDataBuffer` / `prepareBinaryData`, not JSON or manual base64. n8n controls its internal storage representation.

For an endpoint that actually accepts multipart uploads, HTTP Request can send the field as an **n8n Binary File** parameter. Do not manually set multipart Content-Type; the node supplies the boundary. This does not imply that any particular vision/model endpoint supports multipart. Providers requiring image URLs, file IDs, or JSON image content need a documented upload/adapter step.

For bounded HTTP concurrency without Code nodes, use **Loop Over Items** with the desired batch size, HTTP Request, response normalization, and a return edge to the loop. Aggregate its **done** output. Interval-based HTTP batching alone is not a hard maximum of in-flight requests.

## Implementation and limits

The PDF is parsed and inspected in the same isolated worker that renders it, without loading PDF.js/native canvas in the parent via this node. All selected raster dimensions are checked before rendering. One worker processes pages sequentially. Native canvas objects are released by dropping references, not by resizing surfaces to zero; this avoids the native worker-teardown failure reproduced by the multi-page tests. PNG payloads are copied over worker messaging. Idle workers receive a graceful shutdown with a termination fallback.

Defaults: 150 DPI; 50 MiB input; 100 selected pages; 25 million pixels per page; 128 MiB total PNG output per input; 60 seconds per page operation after startup. DPI range: 36-600. Maximum raster edge: 32767 pixels.

Oversized selections/drawings fail explicitly, without truncating pages or silently lowering resolution. These are logical/input/output limits, not a strict process RSS cap: native backing memory is reclaimed by garbage collection, and in-memory n8n binary storage retains outputs. Configure an appropriate supported binary backend and deployment memory limits. The node is not streaming; downstream execution starts after rendering completes.

Parser/renderer startup uses the existing implementation and is not covered by the per-page operation timeout. Configure workflow/caller timeouts separately. HTTP downloads happen before the node; input byte checks here are not a streaming download limit.

Errors fail the input PDF. Continue On Fail emits one error item without binary instead of partial pages from that failed PDF. Any already prepared binary objects follow n8n execution retention/pruning.

## Verification and release

Run `npm test` and `npm run lint`. Tests cover mixed selections, union-before-expansion, invalid pages, actual PNG signatures and rotated dimensions, binary helpers, provenance, multiple inputs, and limit/error cases. Existing renderer/recognition/slice regression tests remain enabled.

Publish a new package version through the normal release process after review and successful CI. This change does not publish a package, deploy n8n, or activate any workflow. Load testing with representative large drawings and the actual n8n binary backend remains an integration acceptance step.
