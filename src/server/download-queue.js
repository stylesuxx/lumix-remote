// Downloads files from the camera one at a time, retrying failures after
// growing delays. While paused, the download in progress is aborted and the
// queue waits; the download function is expected to resume partial files.
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_RETRY_DELAYS_MILLISECONDS = [5000, 15000, 30000, 60000, 120000];
const PROGRESS_INTERVAL_MILLISECONDS = 1000;

// Events: 'progress' (job, at most once a second while it downloads), 'done'
// (job, with receivedBytes and milliseconds), 'failed' ({ job, error,
// retryInMilliseconds }) where retryInMilliseconds is null once the job is
// given up, 'discarded' (job) when a removed job stopped, and 'change'
// whenever the set of pending jobs changes.
export class DownloadQueue extends EventEmitter {
  #jobs = [];
  #isWorking = false;
  #pauseCount = 0;
  #resumed = null;
  #activeJob = null;
  #activeAbort = null;

  // download: (url, destinationPath, onProgress, signal) => Promise, where
  // onProgress(receivedBytes, totalBytes) reports the transfer and signal
  // aborts it.
  constructor({ download, retryDelaysMilliseconds = DEFAULT_RETRY_DELAYS_MILLISECONDS }) {
    super();
    this.download = download;
    this.retryDelaysMilliseconds = retryDelaysMilliseconds;
  }

  get pendingKeys() {
    return this.#jobs.map((job) => job.key);
  }

  get isPaused() {
    return this.#pauseCount > 0;
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

  // Drops a job; one downloading right now is aborted.
  remove(key) {
    const job = this.#jobs.find((queued) => queued.key === key);
    if (!job) {
      return;
    }

    job.isRemoved = true;
    this.#jobs = this.#jobs.filter((queued) => queued !== job);
    if (job === this.#activeJob) {
      this.#activeAbort.abort();
    } else {
      this.emit('discarded', job);
    }
    this.emit('change');
  }

  // Pauses until a matching resume; pauses nest.
  pause() {
    this.#pauseCount += 1;
    if (this.#pauseCount === 1) {
      this.#resumed = Promise.withResolvers();
      this.#activeAbort?.abort();
    }
  }

  resume() {
    if (this.#pauseCount === 0) {
      return;
    }

    this.#pauseCount -= 1;
    if (this.#pauseCount === 0) {
      this.#resumed.resolve();
    }
  }

  async #work() {
    if (this.#isWorking) {
      return;
    }

    this.#isWorking = true;
    while (this.#jobs.length > 0) {
      if (this.isPaused) {
        await this.#resumed.promise;
        continue;
      }

      const retryInMilliseconds = await this.#runFirstJob();
      if (retryInMilliseconds > 0) {
        await sleep(retryInMilliseconds);
      }
    }

    this.#isWorking = false;
  }

  // Resolves to the delay before the job's retry, or 0.
  async #runFirstJob() {
    const job = this.#jobs[0];
    const startedAt = Date.now();
    let lastProgressAt = 0;
    this.#activeJob = job;
    this.#activeAbort = new AbortController();
    try {
      await this.download(
        job.url,
        job.destinationPath,
        (receivedBytes, totalBytes) => {
          job.receivedBytes = receivedBytes;
          job.totalBytes = totalBytes;
          if (Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MILLISECONDS) {
            lastProgressAt = Date.now();
            this.emit('progress', job);
          }
        },
        this.#activeAbort.signal,
      );

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
        this.emit('discarded', job);
        return 0;
      }

      // Aborted by pause: the job stays first and continues after resume.
      if (this.#activeAbort.signal.aborted) {
        return 0;
      }

      const retryInMilliseconds = this.retryDelaysMilliseconds[job.failedAttempts] ?? null;
      job.failedAttempts += 1;
      this.emit('failed', { job, error, retryInMilliseconds });
      if (retryInMilliseconds === null) {
        this.#jobs.shift();
        this.emit('change');

        return 0;
      }

      return retryInMilliseconds;
    } finally {
      this.#activeJob = null;
      this.#activeAbort = null;
    }

    return 0;
  }
}
