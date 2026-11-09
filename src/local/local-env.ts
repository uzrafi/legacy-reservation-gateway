/** Imported first by run-local.ts so these apply before any module reads them. */
process.env.ALLOW_EXPERIMENT_HEADERS ??= 'true';
process.env.LOG_LEVEL ??= 'ERROR';
process.env.POWERTOOLS_LOG_LEVEL ??= process.env.LOG_LEVEL;
