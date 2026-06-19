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
4. Make `custevent_ng_notes_pdf` a **Rich Text** field. NetSuite HTML-escapes the
   values of plain/Long Text fields when building the Advanced PDF data model (same as
   `Formula(Text)` vs `Formula(HTML)`), so a non-rich field renders its tags as literal
   text. Only Rich Text fields are passed to the renderer as raw markup. Apply it to the
   same record/forms. The scrubber already outputs well-formed XHTML, so re-save a
   record to populate it.
5. In the Advanced PDF template, reference the field plainly:
   `${record.custevent_ng_notes_pdf}`
   Do **not** add `?no_esc` — these templates use an undefined output format (no
   auto-escaping), so `?no_esc` throws "output format isn't a markup format". And
   `@unescaped` is not valid syntax. BFO only ships Helvetica/Times/Courier fonts, so
   non-standard `font-family` values (e.g. Inter) fall back unless embedded.

   Fallback — if a Rich Text destination re-normalizes the HTML on save and brings back
   parse errors, keep the field as **Long Text** and decode NetSuite's escaping in the
   template instead (works because the output format is undefined / non-escaping):
   ```
   ${record.custevent_ng_notes_pdf?replace("&lt;","<")?replace("&gt;",">")?replace("&quot;","\"")?replace("&amp;","&")}
   ```
   (`&amp;` must be replaced last.)

### Optional script parameters

Defaults are `custevent1` → `custevent_ng_notes_pdf`. To reuse the script for other
fields without editing code, add these script parameters and set them per deployment:

- `custscript_ng_notes_source` — source rich text field id
- `custscript_ng_notes_target` — target field id
- `custscript_ng_notes_debug` — checkbox/text; set to `T` to log the exact raw and
  scrubbed HTML (Script Execution log, Debug level) for troubleshooting a PDF failure.

## Troubleshooting

- **"attribute style/... must not contain the '<' character"** — there is a stray `<`
  in the notes: a literal `<` someone typed (e.g. "lead time < 2 weeks", "<3"), or a
  tag with a missing quote/`>`. The scrubber escapes these to `&lt;`; turn on
  `custscript_ng_notes_debug` and re-save to capture the raw source if it persists.
- **HTML prints as literal text** — the destination is not a Rich Text field, or the
  template adds `?no_esc` on an undefined output format. See deployment step 5.

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
