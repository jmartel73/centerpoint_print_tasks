/**
 * Offline unit tests for centerpoint_lib_html_pdf_scrub.js
 *
 * The library is an AMD module (define([], factory)) with no NetSuite deps, so we
 * shim a global `define` to capture the factory result and test it under Node.
 *
 *   node test/scrub.test.js
 */
'use strict';

var path = require('path');

var captured;
global.define = function (deps, factory) {
    captured = factory();
};
require(path.join(__dirname, '..', 'SuiteScripts', 'centerpoint', 'centerpoint_lib_html_pdf_scrub.js'));
var scrubHtml = captured.scrubHtml;

var passed = 0;
var failed = 0;

function check(name, actual, expected) {
    if (actual === expected) {
        passed++;
    } else {
        failed++;
        console.error('FAIL: ' + name);
        console.error('  expected: ' + JSON.stringify(expected));
        console.error('  actual:   ' + JSON.stringify(actual));
    }
}

function contains(name, haystack, needle) {
    if (haystack.indexOf(needle) !== -1) {
        passed++;
    } else {
        failed++;
        console.error('FAIL: ' + name);
        console.error('  expected to contain: ' + JSON.stringify(needle));
        console.error('  actual:              ' + JSON.stringify(haystack));
    }
}

function excludes(name, haystack, needle) {
    if (haystack.indexOf(needle) === -1) {
        passed++;
    } else {
        failed++;
        console.error('FAIL: ' + name);
        console.error('  expected NOT to contain: ' + JSON.stringify(needle));
        console.error('  actual:                  ' + JSON.stringify(haystack));
    }
}

// --- empty / null handling -------------------------------------------------
check('null -> empty', scrubHtml(null), '');
check('undefined -> empty', scrubHtml(undefined), '');
check('blank -> empty', scrubHtml('   \n  '), '');

// --- void elements ---------------------------------------------------------
check('br self-closed', scrubHtml('a<br>b'), 'a<br />b');
check('br already self-closed untouched', scrubHtml('a<br/>b'), 'a<br />b');
check('hr self-closed', scrubHtml('<hr>'), '<hr />');
contains('img self-closed + src preserved',
    scrubHtml('<img src="https://x.com/a.png">'),
    '<img src="https://x.com/a.png" />');

// --- entities --------------------------------------------------------------
check('nbsp -> numeric', scrubHtml('a&nbsp;b'), 'a&#160;b');
check('copy -> numeric', scrubHtml('&copy;'), '&#169;');
check('mdash -> numeric', scrubHtml('a&mdash;b'), 'a&#8212;b');
check('xml amp kept', scrubHtml('a&amp;b'), 'a&amp;b');
check('bare ampersand escaped', scrubHtml('Tom & Jerry'), 'Tom &amp; Jerry');
check('ampersand in url escaped',
    scrubHtml('<a href="https://x.com?a=1&b=2">L</a>'),
    '<a href="https://x.com?a=1&amp;b=2">L</a>');
check('numeric entity kept', scrubHtml('a&#160;b'), 'a&#160;b');
check('unknown entity escaped', scrubHtml('&bogus;'), '&amp;bogus;');

// --- balancing -------------------------------------------------------------
check('unclosed p closed', scrubHtml('<p>hello'), '<p>hello</p>');
check('mismatched nesting fixed',
    scrubHtml('<div><p>text</div>'),
    '<div><p>text</p></div>');
check('stray close dropped', scrubHtml('hello</span>'), 'hello');
check('two open p auto-closed as siblings', scrubHtml('<p>a<p>b</p>'), '<p>a</p><p>b</p>');
check('list items auto-closed as siblings',
    scrubHtml('<ul><li>one<li>two</ul>'),
    '<ul><li>one</li><li>two</li></ul>');
check('table cells auto-closed',
    scrubHtml('<table><tr><td>a<td>b</tr></table>'),
    '<table><tr><td>a</td><td>b</td></tr></table>');

// --- stray '<' / malformed tags (BFO "must not contain '<'") ----------------
check('literal less-than in text escaped', scrubHtml('lead time < 2 weeks'), 'lead time &lt; 2 weeks');
check('less-than-three escaped', scrubHtml('I <3 it'), 'I &lt;3 it');
check('lt inside quoted style attr escaped',
    scrubHtml('<p style="a<b">x</p>'),
    '<p style="a&lt;b">x</p>');
contains('tag with missing closing quote does not crash, < neutralized',
    scrubHtml('<p>ok</p><p style="color:#27'),
    '&lt;p style=');
contains('valid tag after a broken one is preserved',
    scrubHtml('<p style="x:1<p style="color:red;">good</p>'),
    '<p style="color:red;">good</p>');

// --- junk removal ----------------------------------------------------------
check('comment removed', scrubHtml('a<!-- note -->b'), 'ab');
excludes('script removed', scrubHtml('<p>ok</p><script>evil()</script>'), 'evil');
excludes('style block removed', scrubHtml('<style>.x{}</style><p>ok</p>'), '.x{');
excludes('msoffice tag removed', scrubHtml('<p>x<o:p></o:p></p>'), 'o:p');
excludes('conditional comment removed',
    scrubHtml('<!--[if gte mso 9]><xml>junk</xml><![endif]--><p>ok</p>'), 'junk');
contains('body unwrapped, content kept',
    scrubHtml('<html><body><p>ok</p></body></html>'), '<p>ok</p>');

// --- attributes ------------------------------------------------------------
check('bare width quoted',
    scrubHtml('<td width=100>x</td>'),
    '<td width="100">x</td>');
check('quoted attr untouched',
    scrubHtml('<td width="100">x</td>'),
    '<td width="100">x</td>');

// --- links & images preserved end to end -----------------------------------
contains('link preserved',
    scrubHtml('<a href="https://x.com">Click</a>'),
    '<a href="https://x.com">Click</a>');

// --- realistic combined sample ---------------------------------------------
var sample = '<html><body>' +
    '<p>Hello&nbsp;<b>world</b> &amp; friends</p>' +
    '<ul><li>one<li>two</ul>' +
    '<p>See <a href="https://ex.com?x=1&y=2">link</a><br>and image:</p>' +
    '<img src="https://ex.com/p.png">' +
    '<!--[if mso]>junk<![endif]-->' +
    '<o:p></o:p>' +
    '</body></html>';
var out = scrubHtml(sample);
console.log('\n--- combined sample output ---\n' + out + '\n');
contains('sample: nbsp numericized', out, '&#160;');
contains('sample: url amp escaped', out, 'x=1&amp;y=2');
contains('sample: img self-closed', out, '<img src="https://ex.com/p.png" />');
contains('sample: br self-closed', out, '<br />');
excludes('sample: no msoffice', out, 'o:p');
excludes('sample: no conditional junk', out, 'junk');
contains('sample: list items closed', out, '<li>one</li>');

// --- regression: real pasted notes content stays well-formed ---------------
var realNotes =
    '<p style="color:#272B32;font-family:Inter;font-size:10.5pt;margin-bottom:0in;margin-right:0in;margin-top:0in;">\n  Opening this project to put on your radar. \n</p>\n' +
    '<p style="color:#272B32;font-family:Inter;font-size:10.5pt;margin-bottom:0in;margin-right:0in;margin-top:0in;">\n   \n</p>\n' +
    '<p style="color:#272B32;font-family:Inter;font-size:10.5pt;margin-bottom:0in;margin-right:0in;margin-top:0in;">\n  Design: No\n</p>';
var realOut = scrubHtml(realNotes);
excludes('real notes: no stray < inside attributes', realOut.replace(/<\/?p[^>]*>/g, ''), '<');
contains('real notes: paragraphs preserved', realOut, 'Opening this project to put on your radar.');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
