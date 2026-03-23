# Layout schema (v1)

## Purpose
Define how docx styles map to Markdown/HTML and how images are stored.

## Fields
- version: integer schema version.
- style_map: mapping of docx style name -> target tag/class.
- list_map: list behavior mapping (bullet/number).
- table: default table format (html or markdown).
- images: output directory and filename pattern.
- headers_footers: include or ignore header/footer content.
- docx_template: optional reference.docx for md->docx.

## Example
```yaml
version: 1
style_map:
  "Heading 1": { tag: "h1" }
  "Heading 2": { tag: "h2" }
  "Body Text": { tag: "p" }
  "Quote": { tag: "blockquote" }
list_map:
  bullet: { tag: "ul", item: "li" }
  number: { tag: "ol", item: "li" }
table:
  default_format: "html"
images:
  dir: "assets/images"
  filename_pattern: "{stem}-{index}{ext}"
  max_width: "640px"
  align: "center"
headers_footers:
  include: false
docx_template:
  reference_docx: "reference.docx"
```
