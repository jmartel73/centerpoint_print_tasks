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
| `<div>` / HTML5 `<section>`,`<header>`… (BFO drops these in flow) | mapped to `<p>` |
| `width=100` | quoted: `width="100"` |

## The solution

A **User Event script** scrubs the Rich Text notes (`custevent1`) into well-formed
XHTML, and a Long Text field that the PDF template references holds the result.
Hyperlinks (`<a href>`) and images (`<img src>`) are preserved.

### Confirmed working configuration (Centerpoint)

The live setup that renders correctly:

- Print record type: `customrecord_ng_eh_link_proj_task_pdf` (printed via the standard
  `hotprint.nl` servlet from a custom button).
- Task reference field on it: `custrecord_ng_eh_projtaskpdf_projtask` → a Project Task.
- Raw notes source: `custevent1` (Rich Text) on the Project Task.
- Local field on the print record: `custrecord_ng_notes_pdf_local` (Long Text).
- Script: `centerpoint_ue_notes_pdf_copy.js` deployed on
  `customrecord_ng_eh_link_proj_task_pdf` (runs on **beforeLoad**, PRINT context).
- Template line (**decode only the tag brackets**):
  ```
  ${record.custrecord_ng_notes_pdf_local?replace("&lt;","<")?replace("&gt;",">")}
  ```

Editing + saving the **task** is enough; the print record is never saved — beforeLoad
recomputes the notes at print time.

**Escaping on the beforeLoad path:** NetSuite escapes the injected value's `<`/`>` to
`&lt;`/`&gt;` (so tags would otherwise print as literal text) but leaves `&` untouched.
The scrubber emits **numeric** entities for content (`&#38;`, `&#60;`, `&#160;`), so the
only `&lt;`/`&gt;` in the delivered value are NetSuite's tag-bracket escaping — decode
exactly those and nothing else. **Do not** decode `&amp;`: there is none, and doing so
turns a valid `&#38;` (e.g. a link's `?rectype=859&#38;id=...`) into a bare `&`, which
BFO rejects with *"entity must end with ';'"*.

Two deployment shapes in general:

- **Notes field and PDF are on the same record** → use `centerpoint_ue_notes_pdf.js`
  (scrubs `custevent1` → `custevent_ng_notes_pdf` on that record).
- **PDF is printed from a record that only *references* the task** (the Centerpoint case
  above), and you only ever save the **task**, not the print record → use **only**
  `centerpoint_ue_notes_pdf_copy.js` on the print record. It runs on **beforeLoad
  (print/email/view)**: it loads the task, scrubs `custevent1`, and sets a local Long
  Text field in memory, which the template references **directly** (no join, no
  truncation). In this shape you do **not** need the other script or a notes field on
  the task.

### Files

| File | Purpose |
|---|---|
| `SuiteScripts/centerpoint/centerpoint_lib_html_pdf_scrub.js` | Reusable, dependency-free scrub library (`scrubHtml`). Always required. |
| `SuiteScripts/centerpoint/centerpoint_ue_notes_pdf.js` | Same-record scrub (`custevent1` → `custevent_ng_notes_pdf`) |
| `SuiteScripts/centerpoint/centerpoint_ue_notes_pdf_copy.js` | Cross-record: loads the related task, scrubs, stores locally (avoids join truncation) |
| `test/scrub.test.js` | Offline unit tests (`node test/scrub.test.js`) |

### Important: do not read the field through a join

Advanced PDF templates **truncate fields read through a record join** (e.g.
`record.custrecord_..._projtask.custevent_ng_notes_pdf` gets cut off around ~1,000
characters, mid-tag, which re-breaks the XHTML). That is what
`centerpoint_ue_notes_pdf_copy.js` solves — it puts the full scrubbed value in a local
field so the template references it **directly**:
```
${record.custrecord_ng_notes_pdf_local?replace("&lt;","<")?replace("&gt;",">")?replace("&quot;","\"")?replace("&amp;","&")}
```

## Deployment

1. Upload both files in `SuiteScripts/centerpoint/` to the File Cabinet (keep them in
   the same folder — the UE script loads the library with a relative path
   `./centerpoint_lib_html_pdf_scrub`).
2. **Customization → Scripting → Scripts → New**, select
   `centerpoint_ue_notes_pdf.js`, type **User Event**.
3. Deploy it to the record type that has these fields (the `custevent` prefix means a
   CRM/event field — Event, Task, Phone Call, Case, etc.). Status **Released**.
4. Make `custevent_ng_notes_pdf` a **Long Text** field (not Rich Text). Long Text
   stores exactly the clean bytes the scrubber writes. A **Rich Text** destination gets
   re-serialized by NetSuite on save and again when read through a join, and that
   round-trip can corrupt otherwise-clean markup (e.g. injecting a `<` into a `style`
   attribute) — verified the hard way. Apply the field to the same record/forms.
5. In the Advanced PDF template, NetSuite delivers a Long Text value HTML-**escaped**
   (`&lt;p&gt;...`), so decode it back to markup right before output:
   ```
   ${record.custevent_ng_notes_pdf?replace("&lt;","<")?replace("&gt;",">")?replace("&quot;","\"")?replace("&amp;","&")}
   ```
   (`&amp;` must be replaced last.) Do **not** use `?no_esc` — these templates use an
   undefined output format (no auto-escaping), so `?no_esc` throws "output format isn't
   a markup format"; `@unescaped` is not valid syntax either. BFO only ships
   Helvetica/Times/Courier fonts, so non-standard `font-family` values (e.g. Inter) fall
   back unless embedded.

   Note: if the value ever arrives **unescaped** (renders as literal tags after the
   decode), drop the `?replace` chain and reference the field plainly — escaping through
   joins vs. direct field access can differ by record/template.

### Optional script parameters

Defaults are `custevent1` → `custevent_ng_notes_pdf`. To reuse the script for other
fields without editing code, add these script parameters and set them per deployment:

- `custscript_ng_notes_source` — source rich text field id
- `custscript_ng_notes_target` — target field id

The script also logs the raw and scrubbed HTML at **debug** level on every save. To
capture it, set the **deployment Log Level to Debug**, save the record, then read the
script's **Execution Log** (entries "NG Notes RAW" / "NG Notes SCRUBBED").

## Troubleshooting

- **The target field only updates when the record that owns it is saved.** If the PDF
  reads the field through a join (e.g.
  `record.custrecord_..._projtask.custevent_ng_notes_pdf`), you must edit & save that
  *related* record (the Project Task), not the record you print, to refresh the value.
- **"attribute style/... must not contain the '<' character"** — two possible causes:
  (1) a stray `<` in the notes (a literal `<` someone typed, or a tag with a missing
  quote/`>`) — the scrubber escapes these to `&lt;`; or (2) **NetSuite converts newlines
  in the stored value into `<br />` tags** when rendering, and a newline sitting *inside*
  a tag (pretty-printed markup) injects a `<br />` into the tag/attribute. The scrubber
  strips raw newlines (`collapseNewlines`) to prevent this. If it persists, set Log Level
  to Debug, re-save, and inspect the "NG Notes RAW" log entry. Tip: `${field?html}` in
  the template prints the delivered value as literal text so you can see exactly what
  arrives (escaped vs. raw, and where any stray `<` is).
- **HTML prints as literal text** — expected for a Long Text field; decode it in the
  template with the `?replace` chain (step 5). Do not use `?no_esc` on an undefined
  output format.
- **Value is cut off mid-tag / `<` error only when decoded** — the template is reading
  the field through a **join**, which truncates it (~1,000 chars). Confirm with
  `${field?length}` in the template. Fix by copying the notes onto the print record
  (see `centerpoint_ue_notes_pdf_copy.js`) and referencing it without a join.

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
