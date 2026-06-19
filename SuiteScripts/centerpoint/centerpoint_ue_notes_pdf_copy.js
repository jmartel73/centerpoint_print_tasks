/**
 * centerpoint_ue_notes_pdf_copy.js
 *
 * Companion to centerpoint_ue_notes_pdf.js. Advanced PDF templates TRUNCATE fields
 * that are read through a record join (e.g.
 *   record.custrecord_ng_eh_projtaskpdf_projtask.custevent_ng_notes_pdf
 * gets cut off around ~1,000 characters, mid-tag, which breaks the XHTML).
 *
 * To avoid the join, this script copies the already-scrubbed notes from the related
 * Project Task onto a Long Text field on the print record itself, so the template can
 * reference it directly (no join, no truncation). record.load returns the full field
 * value, unlike a join or saved-search column.
 *
 * Deploy on the record the PDF is printed from (the one that references the task).
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/runtime', 'N/log'], function (record, runtime, log) {
    'use strict';

    // Field on THIS record that references the Project Task.
    var DEFAULT_TASK_REF_FIELD = 'custrecord_ng_eh_projtaskpdf_projtask';
    // Scrubbed notes field ON the Project Task (populated by centerpoint_ue_notes_pdf).
    var DEFAULT_SOURCE_FIELD = 'custevent_ng_notes_pdf';
    // Long Text field on THIS record to copy the notes into (create this).
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

            var notes = '';
            if (taskId) {
                var task = record.load({ type: taskType, id: taskId, isDynamic: false });
                notes = task.getValue({ fieldId: sourceField }) || '';
            }

            rec.setValue({ fieldId: targetField, value: notes, ignoreFieldChange: true });
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
