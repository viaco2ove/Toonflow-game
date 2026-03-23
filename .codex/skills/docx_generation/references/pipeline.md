# Conversion pipelines

## docx -> md (format-preserving)
1. Convert docx to html (pandoc or mammoth).
2. Embed HTML blocks directly into Markdown.
3. Extract images and rewrite src to relative paths.

## docx -> md (plain Markdown)
1. Convert docx to md (pandoc) or docx->html->md.
2. Accept loss for floating objects, text boxes, and multi-column layouts.

## docx -> layout
1. Enumerate paragraph and character styles from the docx.
2. Map styles to tags/classes in layout.yaml.
3. Capture table styles and list patterns as defaults.

## md -> docx
1. Use pandoc with reference.docx if available.
2. Or build with python-docx using layout.yaml mappings.

## Suggested output structure
- output.md
- assets/images/
- layout.yaml (optional)
- reference.docx (optional)
