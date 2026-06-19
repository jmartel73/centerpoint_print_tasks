/**
 * centerpoint_lib_html_pdf_scrub.js
 *
 * Converts the loose, WYSIWYG HTML produced by a NetSuite Rich Text field into
 * well-formed XHTML that the Advanced PDF/HTML rendering engine (FreeMarker 2.3.x
 * + the BFO / XSL-FO renderer) can parse without errors.
 *
 * The BFO renderer parses template markup as STRICT XML, so the most common
 * causes of "Error during rendering" are:
 *   - void tags that are not self-closed:        <br>  -> <br />
 *   - HTML named entities that are not XML:       &nbsp; -> &#160;
 *   - bare ampersands in text or URLs:            a & b  -> a &amp; b
 *   - unbalanced / unclosed tags:                 <p>..<p>..  /  <div><p>..</div>
 *   - paste junk: <script>/<style>/<head>, comments, MS-Word <o:p> & namespaces
 *   - unquoted attribute values:                  width=100 -> width="100"
 *
 * Hyperlinks (<a href>) and images (<img src>) are deliberately preserved so they
 * keep working when the scrubbed field is mapped into the PDF template.
 *
 * This module intentionally has NO NetSuite ('N/...') dependencies so the core
 * logic can be unit-tested outside of NetSuite (see /test/scrub.test.js).
 *
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define([], function () {
    'use strict';

    // Elements that must be self-closed in XHTML (no closing tag).
    var VOID_ELEMENTS = {
        area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
        link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
    };

    // XML's named entities mapped to numeric. The scrubber emits NUMERIC entities for
    // all content (never named &amp;/&lt;/&gt;), so that when this value is injected
    // into an Advanced PDF the only &lt;/&gt; present come from NetSuite escaping the
    // real tag brackets -- which the template decodes unambiguously. Content entities
    // (e.g. &#38; in a URL, &#60; for a typed '<') survive untouched.
    var XML_ENTITY_TO_NUMERIC = { amp: 38, lt: 60, gt: 62, quot: 34, apos: 39 };

    // Elements with implied end tags: opening one closes any open "peer" on top
    // of the stack (e.g. <li>a<li>b -> <li>a</li><li>b</li> rather than nesting).
    var IMPLIED_CLOSE_PEERS = {
        li: { li: 1 },
        p: { p: 1 },
        dt: { dt: 1, dd: 1 },
        dd: { dt: 1, dd: 1 },
        td: { td: 1, th: 1 },
        th: { td: 1, th: 1 },
        tr: { tr: 1, td: 1, th: 1 },
        option: { option: 1 }
    };

    // Common HTML named entities -> numeric character references.
    var NAMED_ENTITY_TO_NUMERIC = {
        nbsp: 160, iexcl: 161, cent: 162, pound: 163, curren: 164, yen: 165,
        brvbar: 166, sect: 167, uml: 168, copy: 169, ordf: 170, laquo: 171,
        not: 172, shy: 173, reg: 174, macr: 175, deg: 176, plusmn: 177,
        sup2: 178, sup3: 179, acute: 180, micro: 181, para: 182, middot: 183,
        cedil: 184, sup1: 185, ordm: 186, raquo: 187, frac14: 188, frac12: 189,
        frac34: 190, iquest: 191,
        Agrave: 192, Aacute: 193, Acirc: 194, Atilde: 195, Auml: 196, Aring: 197,
        AElig: 198, Ccedil: 199, Egrave: 200, Eacute: 201, Ecirc: 202, Euml: 203,
        Igrave: 204, Iacute: 205, Icirc: 206, Iuml: 207, ETH: 208, Ntilde: 209,
        Ograve: 210, Oacute: 211, Ocirc: 212, Otilde: 213, Ouml: 214, times: 215,
        Oslash: 216, Ugrave: 217, Uacute: 218, Ucirc: 219, Uuml: 220, Yacute: 221,
        THORN: 222, szlig: 223,
        agrave: 224, aacute: 225, acirc: 226, atilde: 227, auml: 228, aring: 229,
        aelig: 230, ccedil: 231, egrave: 232, eacute: 233, ecirc: 234, euml: 235,
        igrave: 236, iacute: 237, icirc: 238, iuml: 239, eth: 240, ntilde: 241,
        ograve: 242, oacute: 243, ocirc: 244, otilde: 245, ouml: 246, divide: 247,
        oslash: 248, ugrave: 249, uacute: 250, ucirc: 251, uuml: 252, yacute: 253,
        thorn: 254, yuml: 255,
        // Punctuation / typography commonly emitted by rich text editors.
        ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205,
        ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218,
        ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225,
        bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243,
        lsaquo: 8249, rsaquo: 8250, euro: 8364, trade: 8482,
        larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596,
        infin: 8734, ne: 8800, le: 8804, ge: 8805
    };

    /**
     * Remove document scaffolding and copy/paste junk while preserving inner
     * text content where appropriate.
     */
    /**
     * Replace every newline (and surrounding runs of newlines/whitespace) with a single
     * space so NetSuite's newline-to-<br /> conversion cannot inject a '<' into a tag.
     */
    function collapseNewlines(html) {
        return html.replace(/\s*[\r\n]+\s*/g, ' ');
    }

    function stripDangerousBlocks(html) {
        // Standard and downlevel-hidden conditional comments (<!--[if]>..<![endif]-->).
        html = html.replace(/<!--[\s\S]*?-->/g, '');
        // Downlevel-revealed conditional comments: <![if !mso]> .. <![endif]>
        html = html.replace(/<!\[[\s\S]*?\]>/g, '');
        // DOCTYPE and XML / processing instructions.
        html = html.replace(/<!\s*doctype[^>]*>/gi, '');
        html = html.replace(/<\?[\s\S]*?\?>/g, '');
        // Drop these elements together with their contents.
        html = html.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
        // Self-closed / orphan versions of the same.
        html = html.replace(/<\/?(?:script|style|head|title|meta|html|body)\b[^>]*>/gi, '');
        // Namespaced / MS-Office tags: <o:p>, </o:p>, <v:shape ...>, <w:...>
        html = html.replace(/<\/?[a-z][a-z0-9]*:[^>]*>/gi, '');
        return html;
    }

    // Matches a single complete, well-formed start/end tag. Attribute values may be
    // single- or double-quoted (and may themselves contain '<', which we fix below)
    // or a simple unquoted token.
    var COMPLETE_TAG_RE = /^<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s+[^\s=\/>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]*))?)*\s*\/?>/;

    /**
     * Neutralize stray '<' characters so the XML parser never runs off the end of a
     * tag. A '<' that does not begin a complete, well-formed tag (a literal "a < b",
     * a "<3", or a tag with a missing quote/'>') is escaped to '&lt;'. A '<' that DOES
     * appear inside an otherwise valid tag's quoted attribute value is also escaped,
     * because XML forbids a literal '<' in attribute values even when quoted -- this is
     * the exact cause of "attribute style must not contain the '<' character".
     */
    function neutralizeStrayBrackets(html) {
        var out = '';
        var i = 0;
        var len = html.length;
        while (i < len) {
            var ch = html.charAt(i);
            if (ch === '<') {
                var match = COMPLETE_TAG_RE.exec(html.slice(i));
                if (match) {
                    // Keep the leading '<'; escape any '<' inside attribute values
                    // (numeric, so it survives the template's &lt; decode).
                    out += '<' + match[0].slice(1).replace(/</g, '&#60;');
                    i += match[0].length;
                } else {
                    out += '&#60;';
                    i += 1;
                }
            } else {
                out += ch;
                i += 1;
            }
        }
        return out;
    }

    /**
     * Ensure every void element is written as a self-closed XHTML tag.
     */
    function selfCloseVoidElements(html) {
        return html.replace(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)\s*\/?>/g, function (match, tag, attrs) {
            if (!VOID_ELEMENTS[tag.toLowerCase()]) {
                return match;
            }
            attrs = attrs.replace(/\s*\/\s*$/, ''); // drop any existing trailing slash
            return '<' + tag + attrs + ' />';
        });
    }

    /**
     * Make all entities XML-legal: keep the 5 XML entities, convert known named
     * entities to numeric, escape unknown named entities, and fix bare ampersands.
     */
    function fixEntities(html) {
        html = html.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, function (match, name) {
            if (XML_ENTITY_TO_NUMERIC[name] != null) {
                return '&#' + XML_ENTITY_TO_NUMERIC[name] + ';';
            }
            if (NAMED_ENTITY_TO_NUMERIC[name] != null) {
                return '&#' + NAMED_ENTITY_TO_NUMERIC[name] + ';';
            }
            // Unknown named entity -> escape its ampersand (numeric) so it renders as text.
            return '&#38;' + name + ';';
        });
        // Any remaining bare ampersand (not already a numeric reference) -> numeric.
        html = html.replace(/&(?!#[0-9]+;|#x[0-9a-fA-F]+;)/g, '&#38;');
        return html;
    }

    /**
     * Quote unquoted values for the attributes rich-text editors most often leave
     * bare (e.g. width=100). Already-quoted values are left untouched.
     */
    function quoteBareAttributes(html) {
        var attrs = 'width|height|border|colspan|rowspan|cellpadding|cellspacing|size|align|valign|color|bgcolor|span';
        var re = new RegExp('(\\s(?:' + attrs + ')\\s*=\\s*)([^\\s"\'>]+)', 'gi');
        return html.replace(re, function (match, prefix, value) {
            return prefix + '"' + value + '"';
        });
    }

    /**
     * Balance tags with a simple stack: drop stray close tags, auto-close any
     * intervening open tags when a higher ancestor closes, and close anything
     * still open at the end. Guarantees well-formed nesting for the XML parser.
     */
    function balanceTags(html) {
        var tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?>/g;
        var stack = [];
        var out = '';
        var lastIndex = 0;
        var match;

        while ((match = tagRe.exec(html)) !== null) {
            var full = match[0];
            var tag = match[1].toLowerCase();
            var isClose = full.charAt(1) === '/';
            var isSelfClose = /\/\s*>$/.test(full) || VOID_ELEMENTS[tag];

            out += html.slice(lastIndex, match.index);
            lastIndex = tagRe.lastIndex;

            if (isClose) {
                var idx = -1;
                for (var i = stack.length - 1; i >= 0; i--) {
                    if (stack[i] === tag) { idx = i; break; }
                }
                if (idx === -1) {
                    continue; // stray close tag with no matching open -> drop it
                }
                for (var j = stack.length - 1; j >= idx; j--) {
                    out += '</' + stack[j] + '>';
                }
                stack.length = idx;
            } else if (isSelfClose) {
                out += full;
            } else {
                // Close any open peer elements with implied end tags first.
                var peers = IMPLIED_CLOSE_PEERS[tag];
                if (peers) {
                    while (stack.length && peers[stack[stack.length - 1]]) {
                        out += '</' + stack.pop() + '>';
                    }
                }
                stack.push(tag);
                out += full;
            }
        }

        out += html.slice(lastIndex);
        for (var k = stack.length - 1; k >= 0; k--) {
            out += '</' + stack[k] + '>';
        }
        return out;
    }

    /**
     * Scrub Rich Text HTML into FreeMarker/BFO-safe XHTML.
     *
     * @param {string} html - raw value from the rich text field (custevent1)
     * @returns {string} well-formed XHTML, or '' for empty/blank input
     */
    function scrubHtml(html) {
        if (html === null || html === undefined) {
            return '';
        }
        html = String(html);
        if (html.replace(/\s+/g, '') === '') {
            return '';
        }

        // Remove raw newlines. NetSuite converts every newline in a stored field value
        // into a <br /> tag when rendering; if a newline sits inside a tag (pretty-
        // printed markup often has them), that injects a '<' into the tag/attribute and
        // breaks the XHTML ("attribute style must not contain the '<' character").
        // Newlines between/inside tags are insignificant HTML whitespace, so replacing
        // them with a space is safe -- block elements still control line breaks.
        html = collapseNewlines(html);

        html = stripDangerousBlocks(html);
        html = neutralizeStrayBrackets(html);
        html = selfCloseVoidElements(html);
        html = fixEntities(html);
        html = quoteBareAttributes(html);
        html = balanceTags(html);

        return html.trim();
    }

    return {
        scrubHtml: scrubHtml,
        // Exposed for targeted unit testing.
        _internal: {
            collapseNewlines: collapseNewlines,
            stripDangerousBlocks: stripDangerousBlocks,
            neutralizeStrayBrackets: neutralizeStrayBrackets,
            selfCloseVoidElements: selfCloseVoidElements,
            fixEntities: fixEntities,
            quoteBareAttributes: quoteBareAttributes,
            balanceTags: balanceTags
        }
    };
});
