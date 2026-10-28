// Downloads files from the camera one at a time, retrying failures after
// growing delays.
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_RETRY_DELAYS_MILLISECONDS = [5000, 15000, 30000, 60000, 120000];
const PROGRESS_INTERVAL_MILLISECONDS = 1000;

// Events: 'progress' (job, at most once a second while it downloads), 'done'
// (job, with receivedBytes and milliseconds), 'failed' ({ job, error,
// retryInMilliseconds }) where retryInMilliseconds is null once the job is
// given up, 'discarded' (job) when a removed job's download finished anyway,
// and 'change' whenever the set of pending jobs changes.
export class DownloadQueue extends EventEmitter {
  #jobs = [];
  #isWorking = false;

  // download: (url, destinationPath, onProgress) => Promise, where
  // onProgress(receivedBytes, totalBytes) reports the transfer.
  constructor({ download, retryDelaysMilliseconds = DEFAULT_RETRY_DELAYS_MILLISECONDS }) {
    super();
    this.download = download;
    this.retryDelaysMilliseconds = retryDelaysMilliseconds;
  }

  get pendingKeys() {
    return this.#jobs.map((job) => job.key);
  }

  // job: { key, url, destinationPath }. A key already queued is ignored.
  add(job) {
    if (this.#jobs.some((queued) => queued.key === job.key)) {
      return;
    }

    this.#jobs.push({ ...job, failedAttempts: 0, isRemoved: false, receivedBytes: 0, totalBytes: null });
    this.emit('change');
    this.#work();
  }

  // Drops a job. One that is downloading right now finishes and is reported
  // as discarded.
  remove(key) {
    const job = this.#jobs.find((queued) => queued.key === key);
    if (!job) {
      return;
    }

    job.isRemoved = true;
    this.#jobs = this.#jobs.filter((queued) => queued !== job);
    this.emit('change');
  }

  async #work() {
    if (this.#isWorking) {
      return;
    }

    this.#isWorking = true;
    while (this.#jobs.length > 0) {
      const job = this.#jobs[0];
      const startedAt = Date.now();
      let lastProgressAt = 0;
      try {
        await this.download(job.url, job.destinationPath, (receivedBytes, totalBytes) => {
          job.receivedBytes = receivedBytes;
          job.totalBytes = totalBytes;
          if (Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MILLISECONDS) {
            lastProgressAt = Date.now();
            this.emit('progress', job);
          }
        });

        job.milliseconds = Date.now() - startedAt;
        if (job.isRemoved) {
          this.emit('discarded', job);
        } else {
          this.#jobs.shift();
          this.emit('done', job);
          this.emit('change');
        }
      } catch (error) {
        if (job.isRemoved) {
          continue;
        }

        const retryInMilliseconds = this.retryDelaysMilliseconds[job.failedAttempts] ?? null;
        job.failedAttempts += 1;
        if (retryInMilliseconds === null) {
          this.#jobs.shift();
          this.emit('failed', { job, error, retryInMilliseconds });
          this.emit('change');
        } else {
          this.emit('failed', { job, error, retryInMilliseconds });
          await sleep(retryInMilliseconds);
        }
      }
    }

    this.#isWorking = false;
  }
}
