/**
 * centerpoint_ue_notes_pdf_copy.js
 *
 * Self-contained: on save of the print record, loads the related Project Task, reads
 * its raw Rich Text notes (custevent1), scrubs them into BFO-safe XHTML, and stores the
 * result in a Long Text field ON the print record. The template then references that
 * local field DIRECTLY (no join).
 *
 * Why local (not a join): Advanced PDF templates truncate fields read through a record
 * join (~1,000 chars, mid-tag), which re-breaks the XHTML. record.load + a local field
 * delivers the full value.
 *
 * This replaces the need for a separate User Event on the Project Task -- the scrub
 * happens here, against the raw source field, so there is a single source of truth.
 *
 * Deploy on the record the PDF is printed from (the one that references the task).
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
    // Long Text field on THIS record to store the scrubbed notes into (create this).
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

    function beforeSubmit(context) {
        if (context.type === context.UserEventType.DELETE) {
            return;
        }

        var taskRefField = getParam('custscript_ng_copy_taskref', DEFAULT_TASK_REF_FIELD);
        var sourceField = getParam('custscript_ng_copy_source', DEFAULT_SOURCE_FIELD);
        var targetField = getParam('custscript_ng_copy_target', DEFAULT_TARGET_FIELD);
        var taskType = getParam('custscript_ng_copy_tasktype', DEFAULT_TASK_TYPE);

        try {
            var rec = context.newRecord;
            var taskId = rec.getValue({ fieldId: taskRefField });

            var raw = '';
            if (taskId) {
                var task = record.load({ type: taskType, id: taskId, isDynamic: false });
                raw = task.getValue({ fieldId: sourceField }) || '';
            }

            var cleaned = scrub.scrubHtml(raw);
            log.debug({ title: 'NG Notes SCRUBBED (' + targetField + ')', details: cleaned });

            rec.setValue({ fieldId: targetField, value: cleaned, ignoreFieldChange: true });
        } catch (e) {
            log.error({
                title: 'NG Notes PDF copy failed',
                details: (e.name || 'Error') + ': ' + (e.message || e) + (e.stack ? '\n' + e.stack : '')
            });
        }
    }

    return {
        beforeSubmit: beforeSubmit
    };
});

