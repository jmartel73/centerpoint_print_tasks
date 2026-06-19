# Rich Text → NetSuite Advanced PDF — Complete Build Spec & Playbook

A self-contained, account-agnostic reference for rendering NetSuite **Rich Text** (or any
HTML) content in an **Advanced PDF/HTML** template without errors. It documents the root
causes, the full scrubbing algorithm (with exact code), NetSuite's escaping behavior, the
template snippets, every deployment pattern, and an error→fix lookup.

This file is written to be **dropped into an AI assistant** as context so it can help build
a new solution. If you are an AI reading this: start at §0.

---

## 0. How to use this document (AI assistant brief)

You are helping a NetSuite developer render rich-text/HTML field content in an Advanced
PDF/HTML template. The core engine is **BFO (Big Faceless Org) / XSL-FO**, which parses
template markup as **strict XML** and supports only a subset of HTML + CSS2. Raw rich
text is not well-formed XML and uses unsupported tags, so it must be **scrubbed** first.

**The solution has three parts that must all be correct, or the PDF fails:**
1. A **scrub library** (`scrubHtml`, §6.1) that converts loose HTML → BFO-safe XHTML.
2. A **delivery script** that gets the scrubbed value to the template (§5).
3. A **template reference** with the correct decode (§4).

**Before writing code, determine these facts from the user (ask if unknown):**

| Question | Why it matters | Default / common answer |
|---|---|---|
| What field holds the rich text, and on what record? | Source of the HTML | `custevent1` (CRM field) |
| Is the PDF printed from the **same** record, or one that **references** it? | Picks deployment pattern A vs B (§5) | often a separate "print/link" record |
| How is the PDF generated — standard **Print/Email** button, or a **custom button/Suitelet** using `N/render`? | Decides `beforeSubmit` vs `beforeLoad` vs scripted render | custom button → usually `hotprint.nl` (standard path, `beforeLoad` fires) |
| Does the user only save one record (e.g. the source), never the print record? | If yes, must compute at print time (`beforeLoad`), not on save | common |

**Decision tree:**
- Notes + PDF on the **same** record, saved normally → **Pattern A** (`beforeSubmit` UE).
- PDF on a **referencing** record; that record **is** saved before printing → Pattern B can
  use `beforeSubmit` OR `beforeLoad`. Prefer **`beforeLoad`** (computes live, no stale copy).
- PDF on a **referencing** record that is **never saved** by the user → **Pattern B,
  `beforeLoad`** (§5.B). This is the most common and most robust.
- PDF built by a **scripted render** (`N/render`) → call `scrubHtml()` inside that script
  before `renderer.addRecord(...)` (§5.C). `beforeLoad` does NOT fire for scripted render.

**Non-negotiable rules (each caused a real, hours-long bug):**
- Target field that the template reads must be **Long Text**, never Rich Text (§5.4).
- **Never** read the field through a **join** in the template — it truncates ~1,000 chars
  mid-tag (§5.5). Inject a local field instead.
- **Never** use `?no_esc` or `@unescaped` — these templates have an undefined output
  format; use the `?replace` decode (§4).
- The scrubber emits **numeric** entities; the template decodes **only** `&lt;`/`&gt;`.
  Do not decode `&amp;` (§3, §4).

---

## 1. Environment & what BFO supports

- **FreeMarker** 2.3.x performs the `${...}` merge. Output format is **undefined**
  (no auto-escaping), so `?no_esc`/`?no_esc`-style built-ins error.
- **BFO / XSL-FO** renders the merged markup as **strict XML**. It supports a subset of
  **HTML + CSS2** (no HTML5, no modern CSS).
- Canonical BFO tag reference: <https://bfo.com/products/report/docs/tags/>.

**Practical "supported / avoid" list** (verify against the BFO ref for edge cases):

| Use | Avoid / convert |
|---|---|
| `<p>`, `<br/>`, `<hr/>`, `<span>` | `<div>` and HTML5 `<section>/<header>/<footer>/<article>/<aside>/<main>/<figure>` → map to `<p>` |
| `<b>/<strong>`, `<i>/<em>`, `<u>`, `<sub>`, `<sup>`, `<font>` | `<script>`, `<style>`, `<head>`, `<meta>` → strip |
| `<a href>`, `<img src>` | `data:` URI images may not render — host at a URL |
| `<table>/<tr>/<td>/<th>/<thead>/<tbody>` | namespaced MS-Office tags `<o:p>`, `<v:*>`, `<w:*>` → strip |
| `<ul>/<ol>/<li>`, `<h1>`–`<h6>` | HTML comments, conditional comments, `<!DOCTYPE>` → strip |
| inline `style` with CSS2 props; BFO **ignores** props it doesn't know (no error) | named entities other than the XML 5 → numeric; `&nbsp;` specifically must be `&#160;` |
| only fonts: **Helvetica, Times, Courier** | other `font-family` (Inter, Aptos…) silently falls back unless a font is embedded |

---

## 2. The scrubbing algorithm

`scrubHtml(raw)` runs these steps **in this exact order** (order matters — e.g. newlines
must go before tag handling; entities after stray-bracket handling):

```
0. null/blank guard            -> '' for null/undefined/whitespace-only
1. collapseNewlines            -> replace \r\n runs with a single space
2. convertUnsupportedBlocks    -> <div>/<section>/... -> <p>
3. stripDangerousBlocks        -> remove comments, doctype, script/style/head, MS-Office, wrappers
4. neutralizeStrayBrackets     -> escape stray '<' and '<' inside attrs to &#60;
5. selfCloseVoidElements       -> <br> -> <br />, <img ...> -> <img ... />
6. fixEntities                 -> all entities -> numeric; bare & -> &#38;
7. quoteBareAttributes         -> width=100 -> width="100"
8. balanceTags                 -> close/auto-close/drop tags for well-formed nesting
9. trim
```

### 2.1 Step-by-step with exact regex and examples

**1. collapseNewlines** — NetSuite turns every newline in a stored value into `<br />`
at render. A newline **inside a tag** (pretty-printed markup, e.g. Outlook paste) then
injects a `<` into the tag. Newlines are insignificant HTML whitespace, so remove them.
```js
html.replace(/\s*[\r\n]+\s*/g, ' ')
```
`<p\nstyle="…">` → `<p style="…">`

**2. convertUnsupportedBlocks** — BFO doesn't render `<div>` in flow; HTML5 sectioning
tags aren't supported. Map to `<p>`, keeping attributes.
```js
['div','section','article','header','footer','aside','main','figure','figcaption']
  .forEach(t => html = html
    .replace(new RegExp('<'+t+'\\b','gi'), '<p')
    .replace(new RegExp('</'+t+'\\s*>','gi'), '</p>'));
```
`<div style="color:red">x</div>` → `<p style="color:red">x</p>`

**3. stripDangerousBlocks** — remove scaffolding/junk:
```js
html.replace(/<!--[\s\S]*?-->/g, '')                              // comments + downlevel-hidden conditionals
    .replace(/<!\[[\s\S]*?\]>/g, '')                              // <![if]>..<![endif]>
    .replace(/<!\s*doctype[^>]*>/gi, '')                          // doctype
    .replace(/<\?[\s\S]*?\?>/g, '')                               // <?xml ... ?> / PIs
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')  // element + content
    .replace(/<\/?(?:script|style|head|title|meta|html|body)\b[^>]*>/gi, '') // orphan wrappers
    .replace(/<\/?[a-z][a-z0-9]*:[^>]*>/gi, '');                  // namespaced <o:p>,<v:*>,<w:*>
```

**4. neutralizeStrayBrackets** — a `<` that is not a complete well-formed tag (a typed
`<`, a `<3`, or a tag with a missing quote/`>`) makes the parser run off the end of a tag.
A `<` inside a quoted attribute value is illegal XML even when quoted. Escape both to
**numeric** `&#60;` (so the template's `&lt;` decode never touches it). Uses a
char-walk with this "complete tag" matcher:
```js
var COMPLETE_TAG_RE = /^<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s+[^\s=\/>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]*))?)*\s*\/?>/;
// at each '<': if COMPLETE_TAG_RE matches the remainder, keep the tag but replace any
// '<' inside it with '&#60;'; otherwise replace the lone '<' with '&#60;'.
```
`lead time < 2` → `lead time &#60; 2`  •  `<p style="a<b">` → `<p style="a&#60;b">`

**5. selfCloseVoidElements** — void tags must self-close in XML.
```js
html.replace(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)\s*\/?>/g, (m, tag, attrs) =>
  VOID_ELEMENTS[tag.toLowerCase()] ? '<'+tag+attrs.replace(/\s*\/\s*$/,'')+' />' : m);
// VOID_ELEMENTS: area base br col embed hr img input link meta param source track wbr
```
`<br>` → `<br />`  •  `<img src="x">` → `<img src="x" />`

**6. fixEntities** — XML allows only `&amp; &lt; &gt; &quot; &apos;` as named entities.
**This scrubber emits everything as NUMERIC** so the template decode is unambiguous (§3).
```js
html.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) =>
       XML_ENTITY_TO_NUMERIC[name] != null ? '&#'+XML_ENTITY_TO_NUMERIC[name]+';'
     : NAMED_ENTITY_TO_NUMERIC[name] != null ? '&#'+NAMED_ENTITY_TO_NUMERIC[name]+';'
     : '&#38;'+name+';')                                          // unknown -> escape the &
    .replace(/&(?!#[0-9]+;|#x[0-9a-fA-F]+;)/g, '&#38;');          // bare & -> &#38;
// XML_ENTITY_TO_NUMERIC = { amp:38, lt:60, gt:62, quot:34, apos:39 }
// NAMED_ENTITY_TO_NUMERIC: nbsp:160, copy:169, reg:174, trade:8482, mdash:8212,
//   ndash:8211, lsquo:8216, rsquo:8217, ldquo:8220, rdquo:8221, hellip:8230, bull:8226,
//   deg:176, … (latin-1 + common typography; full map in §6.1)
```
`&nbsp;`→`&#160;`  •  `&amp;`→`&#38;`  •  `Tom & Jerry`→`Tom &#38; Jerry`  •  `&bogus;`→`&#38;bogus;`

**7. quoteBareAttributes** — quote unquoted values for attributes editors leave bare:
```js
new RegExp('(\\s(?:width|height|border|colspan|rowspan|cellpadding|cellspacing|size|align|valign|color|bgcolor|span)\\s*=\\s*)([^\\s"\'>]+)','gi')
// -> prefix + '"' + value + '"'
```
`<td width=100>` → `<td width="100">`

**8. balanceTags** — stack-based well-forming: drop stray close tags, auto-close
implied-end-tag peers, close anything still open at EOF.
```
- walk tags with /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?>/g
- open non-void: if it has implied-close peers and the stack top is a peer, close peers first; push.
  IMPLIED_CLOSE_PEERS = { li:{li}, p:{p}, dt:{dt,dd}, dd:{dt,dd}, td:{td,th}, th:{td,th},
                          tr:{tr,td,th}, option:{option} }
- close tag: find nearest matching open in the stack; close everything above it; pop. If none, drop it.
- self-close/void: emit as-is.
- EOF: emit closing tags for everything left on the stack.
```
`<p>a<p>b` → `<p>a</p><p>b</p>`  •  `<ul><li>x<li>y</ul>` → `<ul><li>x</li><li>y</li></ul>`
•  `<blockquote><em>t</blockquote>` → `<blockquote><em>t</em></blockquote>`

**Preserved on purpose:** `<a href>`, `<img src>`, `<span>/<b>/<i>/<u>/<strong>/<em>`,
lists, tables, inline `style` (BFO ignores unknown CSS props rather than erroring).

---

## 3. NetSuite's escaping model (the subtle part)

How the value reaches the template depends on the delivery path. **Byte-level traces** for
a scrubbed value containing a real tag and a numeric entity, e.g.
`<a href="...?a=1&#38;b=2">x</a>`:

| Path | NetSuite does | Delivered to template | Correct template handling |
|---|---|---|---|
| **Stored field, direct** `${record.f}` | escapes whole value | `&lt;a href="...&#38;b=2"&gt;x&lt;/a&gt;` (note: `&#38;` is left as-is because `&` of `&#…;` is part of an entity NetSuite recognizes? — treat as: brackets escaped, numeric entities pass) | decode `&lt;`,`&gt;`,`&quot;` |
| **Stored field, via join** `${record.join.f}` | escapes **and truncates ~1,000 chars** | truncated mid-tag | **avoid** (see §5.5) |
| **`beforeLoad`-injected** (script `setValue` in memory) | escapes `<`,`>` → `&lt;`,`&gt;`; **leaves `&` alone** | `&lt;a href="...&#38;b=2"&gt;x&lt;/a&gt;` | decode **only** `&lt;`,`&gt;` |

Key insight that makes the whole thing robust: **because the scrubber emits numeric
entities, the only `&lt;`/`&gt;` in the delivered value come from NetSuite escaping the
real tag brackets.** Decoding just those two recovers the tags and never corrupts content
(`&#38;`, `&#60;`, `&#160;` pass straight through to BFO, which renders them as `&`, `<`, nbsp).

**Why not decode `&amp;`:** the scrubber never emits `&amp;`. If you add
`?replace("&amp;","&")` and the value contains a valid `&#38;` (e.g. a link's
`?rectype=859&#38;id=…`), nothing matches `&amp;` so it's a no-op — but if any upstream
produced `&amp;`, decoding it yields a **bare `&`**, which BFO rejects with *"entity must
end with ';'"*. Keep the decode to brackets only.

---

## 4. Template reference snippets

**`beforeLoad`-injected value (Pattern B — recommended):**
```freemarker
${record.YOUR_LOCAL_FIELD?replace("&lt;","<")?replace("&gt;",">")}
```

**Stored field on the same record (Pattern A):**
```freemarker
${record.YOUR_FIELD?replace("&lt;","<")?replace("&gt;",">")?replace("&quot;","\"")}
```

**Diagnostics you can paste into a template cell:**
```freemarker
${record.YOUR_FIELD?length}                  <#-- char count; ~1000 + cut-off => join truncation -->
[[[START]]]${record.YOUR_FIELD?html}[[[END]]] <#-- shows the raw delivered value as visible text -->
```

Rules: never `?no_esc`/`@unescaped`; never decode `&amp;`; the field must be **Long Text**.

---

## 5. Deployment patterns

### Pattern A — notes field and PDF on the SAME record
1. Source Rich Text field (e.g. `custevent1`) + a **Long Text** target field on the same record.
2. User Event, **`beforeSubmit`**, scrubs source → target on save (`centerpoint_ue_notes_pdf.js`).
3. Template: direct reference + decode (§4).

### Pattern B — PDF printed from a record that REFERENCES the notes (recommended)
*Notes live on a related record; the user saves that related record, not the print record.*
1. On the **print record**, add a **Long Text** field (no "Store Value" needed — it's set in memory).
2. User Event, **`beforeLoad`** (PRINT/EMAIL/VIEW), on the print record
   (`centerpoint_ue_notes_pdf_copy.js`): `record.load`s the related record, scrubs its raw
   notes, and `setValue`s the local field in memory at print time.
3. Template: reference the **local** field + decode `&lt;`/`&gt;` (§4). **Never join.**

### Pattern C — PDF built by a scripted render (`N/render`)
`beforeLoad` does NOT fire for scripted render. In the render code:
```js
require(['./centerpoint_lib_html_pdf_scrub','N/record','N/render'], function(scrub, record, render){
  var rec = record.load({ type: PRINT_TYPE, id: recId });
  var src = record.load({ type: 'projecttask', id: rec.getValue('REF_FIELD') });
  rec.setValue({ fieldId: 'YOUR_LOCAL_FIELD', value: scrub.scrubHtml(src.getValue('custevent1') || '') });
  var renderer = render.create();
  renderer.setTemplateById({ id: TEMPLATE_ID });
  renderer.addRecord({ templateName: 'record', record: rec });
  var pdf = renderer.renderAsPdf();
});
```

### 5.4 Field-type rules (all patterns)
- Target field = **Long Text** (≈1,000,000 chars, no Maximum Length).
  - **Not Rich Text** — it re-serializes on save and re-introduces newlines that break tags.
  - **Not Free-Form Text** — capped (~300/4,000) and truncates long notes.
- It only feeds the PDF → set **Display Type = Hidden** on the form.

### 5.5 The join-truncation trap
Reading a field through a record join in a template (`${record.join.field}`) **truncates
to ~1,000 characters, mid-tag**, which re-breaks the XHTML and produces the `'<'`-in-style
error. Diagnose with `${field?length}` (a value capped near ~1,000 that ends mid-`<…`).
Fix: inject a local field (Pattern B) and reference it directly — never the join.

### 5.6 Reuse via script parameters (no code edits)
- `centerpoint_ue_notes_pdf.js`: `custscript_ng_notes_source`, `custscript_ng_notes_target`
- `centerpoint_ue_notes_pdf_copy.js`: `custscript_ng_copy_taskref`, `custscript_ng_copy_source`,
  `custscript_ng_copy_target`, `custscript_ng_copy_tasktype`

### 5.7 Exact NetSuite setup steps
1. **Upload scripts:** Documents → Files → SuiteScripts → (folder) → Add File. Put the
   library and the UE script **in the same folder** (the UE loads it via the relative path
   `./centerpoint_lib_html_pdf_scrub`).
2. **Create the Script record:** Customization → Scripting → Scripts → New → select the
   **UE** file (NOT the library — the library has no `@NScriptType` and will error if you
   try to register it as an entry point). Type = User Event.
3. **Add a Deployment:** Applies To = the correct record type; Status = Released; Log Level
   = Debug while testing.
4. **Create the target field:** Customization → Lists, Records, & Fields → (CRM/Entity/…
   Fields) → New → Type = Long Text, apply to the record, Display Type = Hidden.
5. **Edit the template:** Customization → Forms → Advanced PDF/HTML Templates → your
   template → Source Code (`</>`) → add the reference from §4.

---

## 6. Reference source code

> Source of truth is the repo. These are embedded so this spec is self-contained.

### 6.1 `centerpoint_lib_html_pdf_scrub.js` (the reusable core — no `N/` deps)

```javascript
/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define([], function () {
    'use strict';

    var VOID_ELEMENTS = { area:1, base:1, br:1, col:1, embed:1, hr:1, img:1, input:1,
        link:1, meta:1, param:1, source:1, track:1, wbr:1 };

    var XML_ENTITY_TO_NUMERIC = { amp:38, lt:60, gt:62, quot:34, apos:39 };

    var IMPLIED_CLOSE_PEERS = {
        li:{li:1}, p:{p:1}, dt:{dt:1,dd:1}, dd:{dt:1,dd:1},
        td:{td:1,th:1}, th:{td:1,th:1}, tr:{tr:1,td:1,th:1}, option:{option:1} };

    var NAMED_ENTITY_TO_NUMERIC = {
        nbsp:160, iexcl:161, cent:162, pound:163, curren:164, yen:165, brvbar:166,
        sect:167, uml:168, copy:169, ordf:170, laquo:171, not:172, shy:173, reg:174,
        macr:175, deg:176, plusmn:177, sup2:178, sup3:179, acute:180, micro:181,
        para:182, middot:183, cedil:184, sup1:185, ordm:186, raquo:187, frac14:188,
        frac12:189, frac34:190, iquest:191, Agrave:192, Aacute:193, Acirc:194,
        Atilde:195, Auml:196, Aring:197, AElig:198, Ccedil:199, Egrave:200, Eacute:201,
        Ecirc:202, Euml:203, Igrave:204, Iacute:205, Icirc:206, Iuml:207, ETH:208,
        Ntilde:209, Ograve:210, Oacute:211, Ocirc:212, Otilde:213, Ouml:214, times:215,
        Oslash:216, Ugrave:217, Uacute:218, Ucirc:219, Uuml:220, Yacute:221, THORN:222,
        szlig:223, agrave:224, aacute:225, acirc:226, atilde:227, auml:228, aring:229,
        aelig:230, ccedil:231, egrave:232, eacute:233, ecirc:234, euml:235, igrave:236,
        iacute:237, icirc:238, iuml:239, eth:240, ntilde:241, ograve:242, oacute:243,
        ocirc:244, otilde:245, ouml:246, divide:247, oslash:248, ugrave:249, uacute:250,
        ucirc:251, uuml:252, yacute:253, thorn:254, yuml:255,
        ensp:8194, emsp:8195, thinsp:8201, zwnj:8204, zwj:8205, ndash:8211, mdash:8212,
        lsquo:8216, rsquo:8217, sbquo:8218, ldquo:8220, rdquo:8221, bdquo:8222,
        dagger:8224, Dagger:8225, bull:8226, hellip:8230, permil:8240, prime:8242,
        Prime:8243, lsaquo:8249, rsaquo:8250, euro:8364, trade:8482, larr:8592,
        uarr:8593, rarr:8594, darr:8595, harr:8596, infin:8734, ne:8800, le:8804, ge:8805 };

    function collapseNewlines(html) { return html.replace(/\s*[\r\n]+\s*/g, ' '); }

    function convertUnsupportedBlocks(html) {
        var blocks = ['div','section','article','header','footer','aside','main','figure','figcaption'];
        for (var i = 0; i < blocks.length; i++) {
            html = html.replace(new RegExp('<' + blocks[i] + '\\b', 'gi'), '<p');
            html = html.replace(new RegExp('</' + blocks[i] + '\\s*>', 'gi'), '</p>');
        }
        return html;
    }

    function stripDangerousBlocks(html) {
        html = html.replace(/<!--[\s\S]*?-->/g, '');
        html = html.replace(/<!\[[\s\S]*?\]>/g, '');
        html = html.replace(/<!\s*doctype[^>]*>/gi, '');
        html = html.replace(/<\?[\s\S]*?\?>/g, '');
        html = html.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
        html = html.replace(/<\/?(?:script|style|head|title|meta|html|body)\b[^>]*>/gi, '');
        html = html.replace(/<\/?[a-z][a-z0-9]*:[^>]*>/gi, '');
        return html;
    }

    var COMPLETE_TAG_RE = /^<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s+[^\s=\/>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]*))?)*\s*\/?>/;

    function neutralizeStrayBrackets(html) {
        var out = '', i = 0, len = html.length;
        while (i < len) {
            if (html.charAt(i) === '<') {
                var match = COMPLETE_TAG_RE.exec(html.slice(i));
                if (match) { out += '<' + match[0].slice(1).replace(/</g, '&#60;'); i += match[0].length; }
                else { out += '&#60;'; i += 1; }
            } else { out += html.charAt(i); i += 1; }
        }
        return out;
    }

    function selfCloseVoidElements(html) {
        return html.replace(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)\s*\/?>/g, function (match, tag, attrs) {
            if (!VOID_ELEMENTS[tag.toLowerCase()]) return match;
            attrs = attrs.replace(/\s*\/\s*$/, '');
            return '<' + tag + attrs + ' />';
        });
    }

    function fixEntities(html) {
        html = html.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, function (match, name) {
            if (XML_ENTITY_TO_NUMERIC[name] != null) return '&#' + XML_ENTITY_TO_NUMERIC[name] + ';';
            if (NAMED_ENTITY_TO_NUMERIC[name] != null) return '&#' + NAMED_ENTITY_TO_NUMERIC[name] + ';';
            return '&#38;' + name + ';';
        });
        html = html.replace(/&(?!#[0-9]+;|#x[0-9a-fA-F]+;)/g, '&#38;');
        return html;
    }

    function quoteBareAttributes(html) {
        var attrs = 'width|height|border|colspan|rowspan|cellpadding|cellspacing|size|align|valign|color|bgcolor|span';
        var re = new RegExp('(\\s(?:' + attrs + ')\\s*=\\s*)([^\\s"\'>]+)', 'gi');
        return html.replace(re, function (m, prefix, value) { return prefix + '"' + value + '"'; });
    }

    function balanceTags(html) {
        var tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?>/g;
        var stack = [], out = '', lastIndex = 0, match;
        while ((match = tagRe.exec(html)) !== null) {
            var full = match[0], tag = match[1].toLowerCase();
            var isClose = full.charAt(1) === '/';
            var isSelfClose = /\/\s*>$/.test(full) || VOID_ELEMENTS[tag];
            out += html.slice(lastIndex, match.index);
            lastIndex = tagRe.lastIndex;
            if (isClose) {
                var idx = -1;
                for (var i = stack.length - 1; i >= 0; i--) { if (stack[i] === tag) { idx = i; break; } }
                if (idx === -1) continue;
                for (var j = stack.length - 1; j >= idx; j--) out += '</' + stack[j] + '>';
                stack.length = idx;
            } else if (isSelfClose) {
                out += full;
            } else {
                var peers = IMPLIED_CLOSE_PEERS[tag];
                if (peers) while (stack.length && peers[stack[stack.length - 1]]) out += '</' + stack.pop() + '>';
                stack.push(tag);
                out += full;
            }
        }
        out += html.slice(lastIndex);
        for (var k = stack.length - 1; k >= 0; k--) out += '</' + stack[k] + '>';
        return out;
    }

    function scrubHtml(html) {
        if (html === null || html === undefined) return '';
        html = String(html);
        if (html.replace(/\s+/g, '') === '') return '';
        html = collapseNewlines(html);
        html = stripDangerousBlocks(html);
        html = convertUnsupportedBlocks(html);
        html = neutralizeStrayBrackets(html);
        html = selfCloseVoidElements(html);
        html = fixEntities(html);
        html = quoteBareAttributes(html);
        html = balanceTags(html);
        return html.trim();
    }

    return { scrubHtml: scrubHtml };
});
```

### 6.2 `centerpoint_ue_notes_pdf_copy.js` (Pattern B — `beforeLoad`)

```javascript
/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['./centerpoint_lib_html_pdf_scrub', 'N/record', 'N/runtime', 'N/log'], function (scrub, record, runtime, log) {
    'use strict';
    var DEFAULT_TASK_REF_FIELD = 'custrecord_ng_eh_projtaskpdf_projtask';
    var DEFAULT_SOURCE_FIELD   = 'custevent1';
    var DEFAULT_TARGET_FIELD   = 'custrecord_ng_notes_pdf_local';
    var DEFAULT_TASK_TYPE      = 'projecttask';

    function getParam(name, fallback) {
        try { var v = runtime.getCurrentScript().getParameter({ name: name });
              return (v && String(v).trim()) ? String(v).trim() : fallback; }
        catch (e) { return fallback; }
    }

    function beforeLoad(context) {
        var UET = context.UserEventType;
        if (context.type !== UET.PRINT && context.type !== UET.EMAIL && context.type !== UET.VIEW) return;
        var taskRefField = getParam('custscript_ng_copy_taskref', DEFAULT_TASK_REF_FIELD);
        var sourceField  = getParam('custscript_ng_copy_source', DEFAULT_SOURCE_FIELD);
        var targetField  = getParam('custscript_ng_copy_target', DEFAULT_TARGET_FIELD);
        var taskType     = getParam('custscript_ng_copy_tasktype', DEFAULT_TASK_TYPE);
        try {
            var rec = context.newRecord;
            var taskId = rec.getValue({ fieldId: taskRefField });
            if (!taskId) return;
            var task = record.load({ type: taskType, id: taskId, isDynamic: false });
            var cleaned = scrub.scrubHtml(task.getValue({ fieldId: sourceField }) || '');
            rec.setValue({ fieldId: targetField, value: cleaned, ignoreFieldChange: true });
        } catch (e) {
            log.error({ title: 'NG Notes PDF inject failed',
                        details: (e.name || 'Error') + ': ' + (e.message || e) + (e.stack ? '\n' + e.stack : '') });
        }
    }
    return { beforeLoad: beforeLoad };
});
```

### 6.3 `centerpoint_ue_notes_pdf.js` (Pattern A — `beforeSubmit`, abbreviated)

```javascript
/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['./centerpoint_lib_html_pdf_scrub', 'N/runtime', 'N/log'], function (scrub, runtime, log) {
    'use strict';
    function beforeSubmit(context) {
        if (context.type === context.UserEventType.DELETE || context.type === context.UserEventType.XEDIT) return;
        var rec = context.newRecord;
        try {
            var cleaned = scrub.scrubHtml(rec.getValue({ fieldId: 'custevent1' }) || '');
            rec.setValue({ fieldId: 'custevent_ng_notes_pdf', value: cleaned, ignoreFieldChange: true });
        } catch (e) { log.error({ title: 'scrub failed', details: e.message || e }); }
    }
    return { beforeSubmit: beforeSubmit };
});
```

---

## 7. Testing (offline, in Node)

The library is a pure AMD module (`define([], factory)`) with no `N/` deps, so a shimmed
`define` lets it run under Node:

```js
var captured;
global.define = function (deps, factory) { captured = factory(); };
require('./centerpoint_lib_html_pdf_scrub.js');
var scrubHtml = captured.scrubHtml;
// assert scrubHtml('<br>') === '<br />', etc.
```

Workflow for a new quirk: add a failing case → fix in the library → keep the suite green.
Useful assertions: output contains no `\n`, no `<div`, no bare `&` (`/&(?!#)/`), every
`<tag>` has a matching close, links/`src` preserved.

---

## 8. Error → cause → fix lookup

| PDF / print error or symptom | Cause | Fix |
|---|---|---|
| *attribute "style" … must not contain the '<' character* | stray `<`; tag with missing quote/`>`; newline turned into `<br />` inside a tag; value truncated mid-tag | scrub steps 1 & 4; if persists, check join truncation (§5.5) |
| *reference to entity "id" must end with the ';' delimiter* | a bare `&` reached BFO (often `?replace("&amp;","&")` over-decoding) | decode only `&lt;`/`&gt;` (§4); scrubber emits numeric `&#38;` |
| *element type "X" must be terminated by the matching end-tag* | unbalanced / mis-nested tags | scrub step 8 (`balanceTags`) |
| HTML **prints as literal text** (tags visible) | not decoded; wrong field type; or `?no_esc` attempted | add `?replace` decode (§4); use Long Text; never `?no_esc` |
| *?no_esc can't be used here… output format isn't a markup format* | undefined output format in the template | remove `?no_esc`; use `?replace` decode |
| `<div>`/`<section>` **text missing** | BFO doesn't render these in flow | scrub step 2 → `<p>` |
| value **cut off**; `${field?length}` ≈ 1,000 | field read through a **join** | inject a local field (Pattern B); never join |
| `&nbsp;` not rendering / odd spacing | BFO quirk | scrubber → `&#160;` |
| `@NScriptType is mandatory…` on upload | tried to register the **library** as a script | only register the **UE** file; library is loaded via `define([...])` |
| wrong font | BFO ships only Helvetica/Times/Courier | non-standard `font-family` falls back; embed a font for an exact match |
| inline image missing | `data:` URI not supported by BFO | host the image at a URL; use `<img src="https://…">` |

---

## 9. Glossary
- **BFO** — Big Faceless Org, the XSL-FO engine NetSuite uses to render Advanced PDFs.
  Strict XML parser, HTML+CSS2 subset.
- **FreeMarker** — the `${...}` templating layer (v2.3.x). Undefined output format here.
- **Advanced PDF/HTML Template** — NetSuite form template (`<pdf>…`) printed via `hotprint.nl`.
- **`hotprint.nl`** — the standard print servlet; `beforeLoad` (PRINT) fires on this path.
- **Void element** — HTML element with no closing tag; must self-close in XML (`<br/>`).
- **Implied end tag** — element auto-closed by a new peer (`<li>`, `<p>`, `<td>`, `<tr>`…).
