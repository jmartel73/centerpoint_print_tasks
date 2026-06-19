/**
 * centerpoint_ue_notes_pdf_copy.js
 *
 * Surfaces a related Project Task's Rich Text notes into the print record's Advanced
 * PDF, scrubbed into BFO-safe XHTML, WITHOUT reading them through a join (joins
 * truncate at ~1,000 chars, mid-tag) and WITHOUT requiring the print record to be saved.
 *
 * It runs on beforeLoad (print / email / view): it loads the referenced task, reads the
 * raw notes (custevent1), scrubs them, and sets the value on the in-memory record so the
 * template can reference it directly. Because it computes at print time, editing the
 * task's notes is enough -- you never have to save the print record.
 *
 * Template reference -- plain, NO decode chain. A beforeLoad-injected value reaches the
 * template raw (NetSuite does not HTML-escape script-set in-memory values the way it
 * escapes DB-sourced fields), and the scrubber already emits valid XHTML, so BFO parses
 * it directly. Decoding here would corrupt valid entities (e.g. &amp; -> bare &):
 *   ${record.custrecord_ng_notes_pdf_local}
 *
 * Deploy on the record the PDF is printed from (the one that references the task). The
 * target field must exist on that record (Long Text); it does not need "Store Value".
 *
 * Note: beforeLoad fires for the standard Print/Email/View actions. If you also generate
 * the PDF from a scripted render (N/render in a Suitelet/scheduled script), call the
 * scrub there too -- beforeLoad does not fire for that path.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['./centerpoint_lib_html_pdf_scrub', 'N/record', 'N/runtime', 'N/log'], function (scrub, record, runtime, log) {
    'use strict';

    // Field on THIS record that references the Project Task.
    var DEFAULT_TASK_REF_FIELD = 'custrecord_ng_eh_projtaskpdf_projtask';
    // Raw Rich Text notes field ON the Project Task.
    var DEFAULT_SOURCE_FIELD = 'custevent1';
    // Field on THIS record the template reads (Long Text).
    var DEFAULT_TARGET_FIELD = 'custrecord_ng_notes_pdf_local';
    // Record type of the referenced task.
    var DEFAULT_TASK_TYPE = 'projecttask';

    function getParam(name, fallback) {
        try {
            var v = runtime.getCurrentScript().getParameter({ name: name });
            return (v && String(v).trim()) ? String(v).trim() : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function beforeLoad(context) {
        var UET = context.UserEventType;
        // Only the read/output contexts -- never on create/edit (would fight the form).
        if (context.type !== UET.PRINT && context.type !== UET.EMAIL && context.type !== UET.VIEW) {
            return;
        }

        var taskRefField = getParam('custscript_ng_copy_taskref', DEFAULT_TASK_REF_FIELD);
        var sourceField = getParam('custscript_ng_copy_source', DEFAULT_SOURCE_FIELD);
        var targetField = getParam('custscript_ng_copy_target', DEFAULT_TARGET_FIELD);
        var taskType = getParam('custscript_ng_copy_tasktype', DEFAULT_TASK_TYPE);

        try {
            var rec = context.newRecord;
            var taskId = rec.getValue({ fieldId: taskRefField });
            if (!taskId) {
                return;
            }

            var task = record.load({ type: taskType, id: taskId, isDynamic: false });
            var cleaned = scrub.scrubHtml(task.getValue({ fieldId: sourceField }) || '');

            rec.setValue({ fieldId: targetField, value: cleaned, ignoreFieldChange: true });
        } catch (e) {
            log.error({
                title: 'NG Notes PDF inject failed',
                details: (e.name || 'Error') + ': ' + (e.message || e) + (e.stack ? '\n' + e.stack : '')
            });
        }
    }

    return {
        beforeLoad: beforeLoad
    };
});
