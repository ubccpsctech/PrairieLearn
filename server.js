var ERR = require('async-stacktrace');
var _ = require('lodash');
var fs = require('fs');
var path = require('path');
var favicon = require('serve-favicon');
var async = require('async');
var express = require('express');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var http = require('http');
var https = require('https');

var logger = require('./lib/logger');
var error = require('./lib/error');
var config = require('./lib/config');
var messageQueue = require('./lib/messageQueue');
var assessments = require('./assessments');
var sqldb = require('./lib/sqldb');
var models = require('./models');
var sprocs = require('./sprocs');
var cron = require('./cron');
var socketServer = require('./lib/socket-server');
var serverJobs = require('./lib/server-jobs');
var syncFromDisk = require('./sync/syncFromDisk');
var syncFromMongo = require('./sync/syncFromMongo');

if (config.startServer) {
    logger.info('PrairieLearn server start');

    configFilename = 'config.json';
    if (process.argv.length > 2) {
        configFilename = process.argv[2];
    }

    config.loadConfig(configFilename);

    if (config.logFilename) {
        logger.addFileLogging(config.logFilename);
        logger.verbose('activated file logging: ' + config.logFilename);
    }
}

var app = express();
app.set('views', __dirname);
app.set('view engine', 'ejs');

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));
app.use(cookieParser());
app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware for all requests
app.use(require('./middlewares/cors'));
app.use(require('./middlewares/authn')); // authentication, set res.locals.authn_user
app.use(require('./middlewares/logRequest'));
app.use(function(req, res, next) {res.locals.urlPrefix = res.locals.plainUrlPrefix = '/pl'; next();});
app.use(function(req, res, next) {res.locals.devMode = (req.app.get('env') == 'development'); next();});

// clear all cached course code in dev mode (no authorization needed)
app.use(require('./middlewares/undefCourseCode'));

// course selection pages don't need authorization
app.use('/pl', require('./pages/home/home'));
app.use('/pl/enroll', require('./pages/enroll/enroll'));

// dev-mode pages are mounted for both out-of-course access (here) and within-course access (see below)
app.use('/pl/admin/reload', require('./pages/adminReload/adminReload'));
app.use('/pl/admin/jobSequence', require('./pages/adminJobSequence/adminJobSequence'));

// redirect plain course page to assessments page
app.use(function(req, res, next) {if (/\/pl\/[0-9]+\/?$/.test(req.url)) {req.url = req.url.replace(/\/?$/, '/courseInstance');} next();});
// course instance entry page just clears cookies and redirects, so no authorization needed
app.use('/pl/:course_instance_id/courseInstance', require('./middlewares/freshStart'));

// all other pages need authorization
app.use('/pl/:course_instance_id', require('./middlewares/authzCourseInstance')); // authorization for the course instance
app.use('/pl/:course_instance_id/admin', require('./middlewares/authzCourseInstanceAdmin'));
app.use('/pl/:course_instance_id', require('./middlewares/navData')); // set res.locals.navData, res.locals.course, res.locals.course_instance
app.use('/pl/:course_instance_id', require('./middlewares/urlPrefix')); // set res.locals.urlPrefix
app.use('/pl/:course_instance_id', require('./middlewares/csrfToken')); // sets and checks res.locals.csrfToken

// redirect to Admin or User page, as appropriate
app.use('/pl/:course_instance_id/redirect', require('./middlewares/redirectToCourseInstanceLanding'));

app.use('/pl/:course_instance_id/effective', require('./pages/effective/effective'));

app.use('/pl/:course_instance_id/assessments', require('./pages/userAssessments/userAssessments'));
app.use('/pl/:course_instance_id/admin/assessments', require('./pages/adminAssessments/adminAssessments'));

// polymorphic pages check type and call next() if they aren't the right page
app.use('/pl/:course_instance_id/admin/assessment/:assessment_id', [
    require('./middlewares/selectAndAuthzAssessment'),
    require('./pages/adminAssessment/adminAssessment'),
]);
app.use('/pl/:course_instance_id/assessment/:assessment_id', [
    require('./middlewares/selectAndAuthzAssessment'),
    require('./pages/userAssessmentHomework/userAssessmentHomework'),
    require('./pages/userAssessmentExam/userAssessmentExam'),
]);
app.use('/pl/:course_instance_id/admin/assessment_instance/:assessment_instance_id', [
    require('./middlewares/selectAndAuthzAssessmentInstance'),
    require('./pages/adminAssessmentInstance/adminAssessmentInstance'),
]);
app.use('/pl/:course_instance_id/assessment_instance/:assessment_instance_id', [
    require('./middlewares/selectAndAuthzAssessmentInstance'),
    require('./pages/userAssessmentInstanceHomework/userAssessmentInstanceHomework'),
    require('./pages/userAssessmentInstanceExam/userAssessmentInstanceExam'),
]);
app.use('/pl/:course_instance_id/assessment_instance/:assessment_instance_id/clientFiles', require('./pages/assessmentInstanceClientFiles/assessmentInstanceClientFiles'));

app.use('/pl/:course_instance_id/admin/users', require('./pages/adminUsers/adminUsers'));
app.use('/pl/:course_instance_id/admin/questions', require('./pages/adminQuestions/adminQuestions'));

app.use('/pl/:course_instance_id/admin/question/:question_id', [
    require('./middlewares/selectAndAuthzAdminQuestion'),
    require('./pages/adminQuestion/adminQuestion'),
]);

app.use('/pl/:course_instance_id/instance_question/:instance_question_id', [
    require('./middlewares/selectAndAuthzInstanceQuestion'),
    require('./pages/userInstanceQuestionHomework/userInstanceQuestionHomework'),
    require('./pages/userInstanceQuestionExam/userInstanceQuestionExam'),
]);
app.use('/pl/:course_instance_id/instance_question/:instance_question_id/file', require('./pages/questionFile/questionFile'));
app.use('/pl/:course_instance_id/instance_question/:instance_question_id/text', require('./pages/questionText/questionText'));

app.use('/pl/:course_instance_id/admin/syncs', require('./pages/adminSyncs/adminSyncs'));
app.use('/pl/:course_instance_id/admin/jobSequence', require('./pages/adminJobSequence/adminJobSequence'));
app.use('/pl/:course_instance_id/admin/reload', require('./pages/adminReload/adminReload'));

// error handling
app.use(require('./middlewares/notFound'));
app.use(require('./pages/error/error'));

var server;

module.exports.startServer = function(callback) {
    if (config.serverType === 'https') {
        var options = {
            key: fs.readFileSync('/etc/pki/tls/private/localhost.key'),
            cert: fs.readFileSync('/etc/pki/tls/certs/localhost.crt'),
            ca: [fs.readFileSync('/etc/pki/tls/certs/server-chain.crt')]
        };
        server = https.createServer(options, app);
        server.listen(config.serverPort);
        logger.verbose('server listening to HTTPS on port ' + config.serverPort);
        callback(null);
    } else if (config.serverType === 'http') {
        server = http.createServer(app);
        server.listen(config.serverPort);
        logger.verbose('server listening to HTTP on port ' + config.serverPort);
        callback(null);
    } else {
        callback('unknown serverType: ' + config.serverType);
    }
};

if (config.startServer) {
    async.series([
        function(callback) {
            var pgConfig = {
                user: config.postgresqlUser,
                database: config.postgresqlDatabase,
                host: config.postgresqlHost,
                password: config.postgresqlPassword,
                max: 10,
                idleTimeoutMillis: 30000,
            };
            logger.verbose('Connecting to database ' + pgConfig.postgresqlUser + '@' + pgConfig.host + ':' + pgConfig.database);
            var idleErrorHandler = function(err) {
                logger.error('idle client error', err);
            };
            sqldb.init(pgConfig, idleErrorHandler, function(err) {
                if (ERR(err, callback)) return;
                logger.verbose('Successfully connected to database');
                callback(null);
            });
        },
        function(callback) {
            models.init(function(err) {
                if (ERR(err, callback)) return;
                callback(null);
            });
        },
        function(callback) {
            sprocs.init(function(err) {
                if (ERR(err, callback)) return;
                callback(null);
            });
        },
        function(callback) {
            cron.init(function(err) {
                if (ERR(err, callback)) return;
                callback(null);
            });
        },
        function(callback) {
            var ampqConfig = {
                amqpAddress: config.amqpAddress,
                amqpResultQueue: config.amqpResultQueue,
                amqpStartQueue: config.amqpStartQueue,
            };
            messageQueue.init(ampqConfig, assessments.processGradingResult, function(err) {
                if (err) err = error.newMessage(err, 'Unable to connect to message queue');
                if (ERR(err, callback)) return;
                callback(null);
            });
        },
        function(callback) {
            logger.verbose('Starting server...');
            module.exports.startServer(function(err) {
                if (ERR(err, callback)) return;
                callback(null);
            });
        },
        function(callback) {
            socketServer.init(server, function(err) {
                if (ERR(err, callback)) return;
                callback(null);
            });
        },
        function(callback) {
            serverJobs.init(function(err) {
                if (ERR(err, callback)) return;
                callback(null);
            });
        },
    ], function(err, data) {
        if (err) {
            logger.error('Error initializing PrairieLearn server:', err, data);
            logger.error('Exiting...');
            process.exit(1);
        } else {
            logger.info('PrairieLearn server ready');
            if (app.get('env') == 'development') {
                logger.info('Go to ' + config.serverType + '://localhost:' + config.serverPort + '/pl');
            }
        }
    });
}

//module.exports = app;