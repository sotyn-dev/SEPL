'use strict';

const crypto = require('crypto');

/** In-memory deploy jobs (process lifetime only). */
const jobs = new Map();

function createJob(meta = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id,
    status: 'queued', // queued | running | ok | error
    steps: [],
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...meta,
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function patchJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  return job;
}

function addStep(id, step) {
  const job = jobs.get(id);
  if (!job) return null;
  job.steps.push({
    at: new Date().toISOString(),
    ...step,
  });
  job.updatedAt = new Date().toISOString();
  return job;
}

module.exports = { createJob, getJob, patchJob, addStep };
