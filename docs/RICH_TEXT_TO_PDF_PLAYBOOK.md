# Rich Text → NetSuite Advanced PDF: Reusable Playbook

A field-tested reference for rendering NetSuite **Rich Text** content in an **Advanced
PDF/HTML** template without errors. The mechanics here are not specific to the
Centerpoint project task notes — they apply any time you need WYSIWYG/rich-text HTML to
render in a NetSuite PDF.

Drop `centerpoint_lib_html_pdf_scrub.js` into any account, point a script at it, and use
the checklist below.

---

## 1. Why rich text breaks the PDF

Advanced PDF/HTML templates use **FreeMarker** (2.3.x) for the merge, but the actual
rendering is done by the **BFO / XSL-FO engine**, which parses the markup as **strict
XML** and supports only a **subset of HTML + CSS2**. Rich-text editors (and Word/Outlook
paste) emit HTML5-ish markup that is not well-formed XML and uses tags BFO ignores. The
result is parse errors or silently-missing content.

The library converts that loose HTML into BFO-safe XHTML. Everything it does is listed
in §2; the template/field rules are in §4; the error lookup is in §6.

---

## 2. What the scrubber does (every transformation)

Applied in this order by `scrubHtml(raw)`:

| # | Step (function) | Problem it fixes | Example before → after |
|---|---|---|---|
| 1 | `collapseNewlines` | NetSuite turns every newline in a stored value into `<br />` at render; a newline **inside a tag** then injects a `<` into the tag. | `<p\nstyle="…">` → `<p style="…">` |
| 2 | `convertUnsupportedBlocks` | BFO doesn't render `<div>` in flow; HTML5 sectioning tags aren't supported — text vanishes. | `<div style="…">x</div>` → `<p style="…">x</p>` (also `section/article/header/footer/aside/main/figure/figcaption`) |
| 3 | `stripDangerousBlocks` | Document scaffolding & paste junk aren't valid in a fragment. | removes `<!-- … -->`, `<![if]>…<![endif]>`, `<!DOCTYPE>`, `<?xml?>`, `<script>/<style>/<head>/<title>…</…>`, `<html>/<body>/<meta>` wrappers, and namespaced MS-Office tags `<o:p>`,`<v:…>`,`<w:…>` |
| 4 | `neutralizeStrayBrackets` | A stray `<` (typed `<`, or a tag with a missing quote/`>`) makes the parser run off the end of a tag → `'<' in attribute`. | `lead time < 2` → `lead time &#60; 2`; `<p style="a<b">` → `<p style="a&#60;b">` |
| 5 | `selfCloseVoidElements` | XML requires void tags self-closed. | `<br>`, `<img src="…">`, `<hr>` → `<br />`, `<img src="…" />`, `<hr />` |
| 6 | `fixEntities` | XML allows only 5 named entities; everything else must be numeric. Bare `&` is illegal. **All output is numeric** so the template decode (§4) is unambiguous. | `&nbsp;`→`&#160;`, `&copy;`→`&#169;`, `&amp;`→`&#38;`, `Tom & Jerry`→`Tom &#38; Jerry`, `&bogus;`→`&#38;bogus;` |
| 7 | `quoteBareAttributes` | Unquoted attribute values aren't valid XML. | `<td width=100>` → `<td width="100">` (also height, border, colspan, rowspan, cellpadding, cellspacing, size, align, valign, color, bgcolor, span) |
| 8 | `balanceTags` | Unclosed / mis-nested tags → "must be terminated by the matching end-tag". Stack-based: drops stray closes, auto-closes implied peers (`li`,`p`,`td`,`th`,`tr`,`dt`,`dd`,`option`), closes anything still open at EOF. | `<p>a<p>b` → `<p>a</p><p>b</p>`; `<ul><li>x<li>y</ul>` → `<ul><li>x</li><li>y</li></ul>` |
| — | `trim` | tidy | — |

**Preserved on purpose:** `<a href>` hyperlinks, `<img src>` images, `<span>/<b>/<i>/<u>/<strong>/<em>`, lists, tables, and inline `style` (BFO ignores CSS properties it doesn't understand rather than erroring).

---

## 3. The NetSuite escaping model (the part that trips everyone up)

How a value reaches the template depends on **how it's delivered**, and the template
handling differs accordingly:

| Delivery path | What NetSuite does to the value | Template reference |
|---|---|---|
| **Stored field, read directly** (`${record.fieldid}`) | HTML-escapes the whole value (plain/Long Text). It prints as literal text unless decoded. | decode `&lt;`,`&gt;`,`&quot;` |
| **Stored field, read through a join** (`${record.join.fieldid}`) | Same escaping **plus truncation** (~1,000 chars, mid-tag). Avoid — see §5. | (avoid) |
| **Injected in `beforeLoad`** (script sets the field in memory) | Escapes `<` and `>` → `&lt;`/`&gt;`, **but leaves `&` alone**. | decode `&lt;`,`&gt;` only — see §4 |

Because the scrubber emits **numeric** entities (`&#38;`, `&#60;`, `&#160;`), the only
`&lt;`/`&gt;` in a delivered value come from NetSuite escaping the **real tag brackets** —
so decoding just those two is safe and never corrupts content.

> **Never use `?no_esc` or `@unescaped`.** These templates run an *undefined* output
> format (no auto-escaping), so `?no_esc` throws *"output format isn't a markup format"*
> and `@unescaped` isn't valid syntax. Use the `?replace` decode instead.

---

## 4. Template reference (copy/paste)

**`beforeLoad`-injected value (the robust pattern, see §5):**
```freemarker
${record.YOUR_LOCAL_FIELD?replace("&lt;","<")?replace("&gt;",">")}
```

**Stored field read directly on the same record:**
```freemarker
${record.YOUR_FIELD?replace("&lt;","<")?replace("&gt;",">")?replace("&quot;","\"")}
```

Do **not** add `?replace("&amp;","&")` — the scrubber emits no `&amp;`, and decoding it
turns a valid `&#38;` (e.g. a link's `?a=1&#38;b=2`) into a bare `&`, which BFO rejects
with *"entity must end with ';'"*.

---

## 5. Deployment patterns — pick one

### A. Notes field and PDF are on the **same record**
1. Source Rich Text field (e.g. `custevent1`) + a **Long Text** target field.
2. Deploy `centerpoint_ue_notes_pdf.js` (User Event, `beforeSubmit`) on that record.
3. Template: direct reference with the decode (§4).

### B. PDF is printed from a record that **references** the one with the notes
*(notes on a related record; you only save the related record, not the print record)*
1. Add a **Long Text** field on the **print record** (no "Store Value" needed).
2. Deploy `centerpoint_ue_notes_pdf_copy.js` (User Event, **`beforeLoad`**) on the print
   record. It `record.load`s the related record, scrubs the raw notes, and sets the local
   field in memory at print time.
3. Template: reference the **local** field directly (§4) — **never through a join**.

**Why not a join?** Advanced PDF truncates joined field values (~1,000 chars), mid-tag,
which re-breaks the XHTML. Diagnose with `${field?length}` — a value capped near ~1,000
that ends mid-`<…` is the tell. Confirmed on the standard `hotprint.nl` print path
(`beforeLoad` fires there). If the PDF is built by a **scripted render** (`N/render` in a
Suitelet/scheduled script), `beforeLoad` does **not** fire — call `scrub.scrubHtml()` in
that render code and set the field on the record before `renderer.addRecord(...)`.

### Field type rules (both patterns)
- Target field = **Long Text** (not Rich Text — Rich Text re-serializes on save and
  re-introduces newlines/breaks). ~1,000,000 char capacity, no Maximum Length.
- It only feeds the PDF, so set **Display Type = Hidden** on the form.

### Reusing for a different field/record
The scripts read field IDs from **script parameters** (defaults match Centerpoint):
- `centerpoint_ue_notes_pdf.js`: `custscript_ng_notes_source`, `custscript_ng_notes_target`
- `centerpoint_ue_notes_pdf_copy.js`: `custscript_ng_copy_taskref`, `custscript_ng_copy_source`, `custscript_ng_copy_target`, `custscript_ng_copy_tasktype`

Set those per deployment and you never have to touch the code.

---

## 6. Error → cause → fix lookup

| PDF / print error or symptom | Cause | Fix |
|---|---|---|
| *The value of attribute "style"… must not contain the '<' character* | stray `<`, tag with missing quote/`>`, a newline turned into `<br />` inside a tag, or a value truncated mid-tag | scrubber steps 1 & 4 handle the first three; if it persists, check for join truncation (§5) |
| *The reference to entity "id" must end with the ';' delimiter* | a bare `&` reached BFO — usually the decode chain over-decoded `&#38;`/`&amp;` | remove `?replace("&amp;","&")`; decode only `&lt;`/`&gt;` (§4) |
| *…must be terminated by the matching end-tag* | unbalanced / mis-nested tags | scrubber step 8 (`balanceTags`) |
| HTML **prints as literal text** (tags visible) | value not decoded, or wrong field type, or `?no_esc` attempted | add the `?replace` decode (§4); use Long Text; never `?no_esc` |
| *?no_esc can't be used here… output format isn't a markup format* | template has an undefined output format | remove `?no_esc`; use the `?replace` decode |
| `<div>` (or `<section>`…) **text missing** | BFO doesn't render these in flow | scrubber step 2 maps them to `<p>` |
| Value **cut off** mid-tag; `${field?length}` ≈ 1,000 | reading a field through a **join** | don't join — inject locally (§5 pattern B) |
| `&nbsp;` not rendering / odd spacing | BFO quirk with `&nbsp;` | scrubber converts it to `&#160;` (handled) |
| Wrong font | BFO ships only Helvetica/Times/Courier | non-standard `font-family` (Inter, Aptos…) falls back; embed a font if exact match needed |

---

## 7. Files & tests

| File | Role |
|---|---|
| `SuiteScripts/centerpoint/centerpoint_lib_html_pdf_scrub.js` | the scrubber (`scrubHtml`) — **the reusable core**, no NetSuite deps |
| `SuiteScripts/centerpoint/centerpoint_ue_notes_pdf.js` | same-record User Event (pattern A) |
| `SuiteScripts/centerpoint/centerpoint_ue_notes_pdf_copy.js` | cross-record `beforeLoad` (pattern B) |
| `test/scrub.test.js` | offline unit tests — `node test/scrub.test.js` |

The scrub library is a pure AMD module with **no `N/` dependencies**, so it runs in Node
for testing and can be reused verbatim in any NetSuite account. When you hit a new
rich-text quirk, add a failing case to `test/scrub.test.js`, fix it in the library, and
the whole regression suite keeps you safe.
