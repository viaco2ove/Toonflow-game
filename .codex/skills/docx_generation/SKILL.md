---
name: docx-generation
description: "Convert DOCX and Markdown with layout extraction, image export, and formatting-preserving pipelines. Use when working with .docx files to: (1) convert docx-to-md or docx-to-md+HTML, (2) extract images, (3) generate or apply layout mapping files, or (4) generate docx from one or more md files."
---

# DOCX Generation

## Quick start
- Determine direction: docx->md, docx->md+html, docx->layout, or md->docx.
- Prefer docx->html->md with embedded HTML blocks when formatting must be preserved.
- Always export images to a stable assets folder and use relative links.

## Layout files
- Use a YAML/JSON mapping file to map docx styles to Markdown/HTML.
- Pair with an optional reference.docx when generating docx from Markdown.
- See references/layout-schema.md for the minimal schema and example.

## Tool selection
- Prefer pandoc when available for docx<->md conversion.
- Use mammoth + python-docx when a pure-Python pipeline is required.
- See references/pipeline.md for step-by-step pipelines and tradeoffs.

## Output structure
- Keep outputs together: output.md, assets/images/, and layout.yaml (optional).
- Use kebab-case or snake_case for generated filenames.

## Notes
- Do not promise lossless conversion for text boxes, floating objects, multi-column layouts, or complex table styling.
- Fall back to embedded HTML blocks when Markdown cannot represent structure.
