const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();

function getSignal() { return context.getStore()?.signal; }
function assertActive() { getSignal()?.throwIfAborted(); }

function abortable(operation, signal = getSignal()) {
    if (!signal) return Promise.resolve().then(operation);
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => {
            signal.throwIfAborted();
            return operation();
        }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

function guardedSocket(sock) {
    return new Proxy(sock, {
        get(target, key) {
            const value = target[key];
            if (typeof value !== 'function') return value;
            return (...args) => abortable(() => value.apply(target, args));
        },
    });
}

class JobQueue {
    constructor({ capacity = 20, timeoutMs = 180000, onError = console.error, onTimeout = () => {} } = {}) {
        Object.assign(this, { capacity, timeoutMs, onError, onTimeout });
        this.pending = 0;
        this.tail = Promise.resolve();
        this.accepting = true;
    }
    enqueue(work) {
        if (!this.accepting || this.pending >= this.capacity) return false;
        this.pending++;
        this.tail = this.tail.then(async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => {
                controller.abort(new Error('Waktu pemrosesan pesan habis'));
                try { this.onTimeout(); } catch (error) { this.onError(error); }
            }, this.timeoutMs);
            try {
                // Work must use abortable I/O and assertActive before mutations.
                if (this.accepting) {
                    await context.run({ signal: controller.signal }, () => abortable(() => work(controller.signal)));
                }
            } catch (error) {
                this.onError(error);
            } finally {
                clearTimeout(timer);
                this.pending--;
            }
        });
        return true;
    }
    async stop() { this.accepting = false; await this.tail; }
}
module.exports = { JobQueue, getSignal, assertActive, abortable, guardedSocket };
