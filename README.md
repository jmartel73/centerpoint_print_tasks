# Centerpoint — Rich Text → Advanced PDF notes scrubber

Maps a NetSuite **Rich Text** field into an Advanced PDF/HTML template without the
rendering errors that loose WYSIWYG HTML normally causes.

## The problem

NetSuite Advanced PDF/HTML templates use FreeMarker (2.3.x) for templating, but the
actual rendering is done by the **BFO / XSL-FO engine**, which parses the markup as
**strict XML**. Rich Text fields emit HTML5-style markup that is *not* well-formed
XML, so mapping `custevent1` straight into the template throws errors. The usual
culprits:

| Rich text emits | BFO needs |
|---|---|
| `<br>`, `<img ...>`, `<hr>` | self-closed: `<br />`, `<img ... />` |
| `&nbsp;` `&copy;` `&mdash;` | numeric refs: `&#160;` `&#169;` `&#8212;` (XML only allows `&amp; &lt; &gt; &quot; &apos;`) |
| `Tom & Jerry`, `?a=1&b=2` | escaped: `Tom &amp; Jerry`, `?a=1&amp;b=2` |
| `<p>a<p>b`, `<div><p>x</div>` | balanced, well-formed nesting |
| `<script>`/`<style>`/`<head>`, comments, MS-Word `<o:p>`, conditional comments | removed |
| `width=100` | quoted: `width="100"` |

## The solution

A **User Event script** runs on every save, reads the Rich Text field
(`custevent1`), scrubs the HTML into well-formed XHTML, and writes it to
`custevent_ng_notes_pdf`. **Map that field into the PDF template** instead of the
raw rich text field. Hyperlinks (`<a href>`) and images (`<img src>`) are preserved,
so they keep working in the PDF.

### Files

| File | Purpose |
|---|---|
| `SuiteScripts/centerpoint/centerpoint_lib_html_pdf_scrub.js` | Reusable, dependency-free scrub library (`scrubHtml`) |
| `SuiteScripts/centerpoint/centerpoint_ue_notes_pdf.js` | User Event script (`beforeSubmit`) wiring the field to the library |
| `test/scrub.test.js` | Offline unit tests (`node test/scrub.test.js`) |

## Deployment

1. Upload both files in `SuiteScripts/centerpoint/` to the File Cabinet (keep them in
   the same folder — the UE script loads the library with a relative path
   `./centerpoint_lib_html_pdf_scrub`).
2. **Customization → Scripting → Scripts → New**, select
   `centerpoint_ue_notes_pdf.js`, type **User Event**.
3. Deploy it to the record type that has these fields (the `custevent` prefix means a
   CRM/event field — Event, Task, Phone Call, Case, etc.). Status **Released**.
4. Make sure `custevent_ng_notes_pdf` exists, is large enough for the content
   (Long Text / Rich Text), and is applied to the same record/forms.
5. In the Advanced PDF template, render the new field **unescaped**, e.g.
   `${record.custevent_ng_notes_pdf@unescaped}` (or `<#noescape>...</#noescape>`),
   so the HTML is rendered as markup rather than printed as text.

### Optional script parameters

Defaults are `custevent1` → `custevent_ng_notes_pdf`. To reuse the script for other
fields without editing code, add these script parameters and set them per deployment:

- `custscript_ng_notes_source` — source rich text field id
- `custscript_ng_notes_target` — target field id

## Notes / limitations

- Runs on **create, edit, and copy**. Inline (list) edits and deletes are skipped —
  rich text isn't inline-editable, and an xedit record is partial.
- Scrub failures are logged and never block the save.
- The scrubber is regex/stack based (NetSuite has no DOM parser available to scripts).
  It targets the markup real rich-text editors produce; pathological hand-written HTML
  (e.g. `>` inside an unquoted attribute value) may not be handled.
- Pasted **inline images as `data:` URIs** may not render in BFO; host images at a URL
  for reliable output. Linked/hosted `<img src="https://...">` work.

## Tests

```bash
node test/scrub.test.js
```
