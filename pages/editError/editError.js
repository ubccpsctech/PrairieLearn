const ERR = require('async-stacktrace');
const express = require('express');
const router = express.Router();
const serverJobs = require('../../lib/server-jobs');
const syncHelpers = require('../shared/syncHelpers');

router.get('/:job_sequence_id', function(req, res, next) {
    const job_sequence_id = req.params.job_sequence_id;
    const course_id = res.locals.course ? res.locals.course.id : null;
    serverJobs.getJobSequence(job_sequence_id, course_id, (err, job_sequence) => {
        if (ERR(err, next)) return;

        // All edits wait for the corresponding job sequence to finish before
        // proceeding, so something bad must have happened to get to this page
        // with a sequence that is still running
        if (job_sequence.status == 'Running') return next(new Error('Edit is still in progress (job sequence is still running)'));

        res.locals.failedPush = false;
        job_errors = [];
        job_sequence.jobs.forEach((item) => {
            if (item.status == 'Error') {
                job_errors.push({
                    'description': item.description,
                    'error_message': item.error_message,
                });

                if (item.type == 'git_push') res.locals.failedPush = true;
            }
        });

        if (job_errors.length == 0) return next(new Error('Could not find a job that caused the edit failure'));

        res.locals.job_sequence = job_sequence;
        res.locals.job_errors = job_errors;
        res.render(__filename.replace(/\.js$/, '.ejs'), res.locals);
    });
});

router.post('/:job_sequence_id', (req, res, next) => {
    if (!res.locals.authz_data.has_course_permission_edit) return next(new Error('Access denied'));

    if (req.body.__action == 'pull') {
        syncHelpers.pullAndUpdate(res.locals, function(err, job_sequence_id) {
            if (ERR(err, next)) return;
            res.redirect(res.locals.urlPrefix + '/jobSequence/' + job_sequence_id);
        });
    } else {
        return next(error.make(400, 'unknown __action', {locals: res.locals, body: req.body}));
    }
});

module.exports = router;