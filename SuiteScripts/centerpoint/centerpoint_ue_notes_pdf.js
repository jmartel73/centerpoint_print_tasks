/**
 * centerpoint_ue_notes_pdf.js
 *
 * On save, reads the Rich Text notes field (custevent1), scrubs the HTML into
 * well-formed XHTML that the Advanced PDF/HTML engine (FreeMarker + BFO) can
 * render, and stores the result in custevent_ng_notes_pdf. Map THAT field into
 * the PDF template instead of the raw rich text field.
 *
 * Runs in beforeSubmit so the cleaned value is written as part of the same save
 * (no extra record.submitFields call needed).
 *
 * Field ids can be overridden per deployment via the optional script parameters
 * custscript_ng_notes_source / custscript_ng_notes_target.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['./centerpoint_lib_html_pdf_scrub', 'N/runtime', 'N/log'], function (scrub, runtime, log) {
    'use strict';

    var DEFAULT_SOURCE_FIELD = 'custevent1';
    var DEFAULT_TARGET_FIELD = 'custevent_ng_notes_pdf';

    function getFieldId(paramName, fallback) {
        try {
            var value = runtime.getCurrentScript().getParameter({ name: paramName });
            return (value && String(value).trim()) ? String(value).trim() : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function beforeSubmit(context) {
        var type = context.type;

        // Skip deletes and inline (list) edits: rich text is not inline-editable,
        // and an xedit record is partial, so the source field may be absent.
        if (type === context.UserEventType.DELETE || type === context.UserEventType.XEDIT) {
            return;
        }

        var sourceField = getFieldId('custscript_ng_notes_source', DEFAULT_SOURCE_FIELD);
        var targetField = getFieldId('custscript_ng_notes_target', DEFAULT_TARGET_FIELD);

        try {
            var rec = context.newRecord;
            var raw = rec.getValue({ fieldId: sourceField });
            var cleaned = scrub.scrubHtml(raw);

            rec.setValue({
                fieldId: targetField,
                value: cleaned,
                ignoreFieldChange: true
            });
        } catch (e) {
            // Never block the save because of a formatting problem in the notes.
            log.error({
                title: 'NG Notes PDF scrub failed',
                details: (e.name || 'Error') + ': ' + (e.message || e) + (e.stack ? '\n' + e.stack : '')
            });
        }
    }

    return {
        beforeSubmit: beforeSubmit
    };
});
