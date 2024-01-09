"use strict";
/* eslint-disable promise/prefer-await-to-callbacks */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.exec = void 0;
const child_process_1 = require("child_process");
const shell_quote_1 = require("shell-quote");
const bluebird_1 = __importDefault(require("bluebird"));
const lodash_1 = __importDefault(require("lodash"));
const helpers_1 = require("./helpers");
const MAX_BUFFER_SIZE = 100 * 1024 * 1024;
/**
 * Spawns a process
 * @template {AITProcessExecOptions} T
 * @param {string} cmd - Program to execute
 * @param {string[]} [args] - Arguments to pass to the program
 * @param {T} [opts] - Options
 * @returns {Promise<BufferProp<T> extends true ? AITProcessExecBufferResult : AITProcessExecStringResult>}
 */
async function exec(cmd, args = [], opts = /** @type {T} */ ({})) {
    // get a quoted representation of the command for error strings
    const rep = (0, shell_quote_1.quote)([cmd, ...args]);
    // extend default options; we're basically re-implementing exec's options
    // for use here with spawn under the hood
    opts = /** @type {T} */ (lodash_1.default.defaults(opts, {
        timeout: null,
        encoding: 'utf8',
        killSignal: 'SIGTERM',
        cwd: undefined,
        env: process.env,
        ignoreOutput: false,
        stdio: 'inherit',
        isBuffer: false,
        shell: undefined,
        logger: undefined,
        maxStdoutBufferSize: MAX_BUFFER_SIZE,
        maxStderrBufferSize: MAX_BUFFER_SIZE,
    }));
    const isBuffer = Boolean(opts.isBuffer);
    // this is an async function, so return a promise
    return await new bluebird_1.default((resolve, reject) => {
        // spawn the child process with options; we don't currently expose any of
        // the other 'spawn' options through the API
        let proc = (0, child_process_1.spawn)(cmd, args, { cwd: opts.cwd, env: opts.env, shell: opts.shell });
        let stdoutArr = [], stderrArr = [], timer = null;
        // if the process errors out, reject the promise
        proc.on('error', /** @param {NodeJS.ErrnoException} err */ async (err) => {
            if (err.code === 'ENOENT') {
                err = await (0, helpers_1.formatEnoent)(err, cmd, opts.cwd?.toString());
            }
            reject(err);
        });
        if (proc.stdin) {
            proc.stdin.on('error', /** @param {NodeJS.ErrnoException} err */ (err) => {
                reject(new Error(`Standard input '${err.syscall}' error: ${err.stack}`));
            });
        }
        const handleStream = (streamType, streamProps) => {
            if (!proc[streamType]) {
                return;
            }
            proc[streamType].on('error', (err) => {
                reject(new Error(`${lodash_1.default.capitalize(streamType)} '${err.syscall}' error: ${err.stack}`));
            });
            if (opts.ignoreOutput) {
                // https://github.com/nodejs/node/issues/4236
                proc[streamType].on('data', () => { });
                return;
            }
            // keep track of the stream if we don't want to ignore it
            const { chunks, maxSize } = streamProps;
            let size = 0;
            proc[streamType].on('data', (chunk) => {
                chunks.push(chunk);
                size += chunk.length;
                while (chunks.length > 1 && size >= maxSize) {
                    size -= chunks[0].length;
                    chunks.shift();
                }
                if (opts.logger && lodash_1.default.isFunction(opts.logger.debug)) {
                    opts.logger.debug(chunk.toString());
                }
            });
        };
        handleStream('stdout', {
            maxSize: opts.maxStdoutBufferSize,
            chunks: stdoutArr,
        });
        handleStream('stderr', {
            maxSize: opts.maxStderrBufferSize,
            chunks: stderrArr,
        });
        /**
         * @template {boolean} U
         * @param {U} isBuffer
         * @returns {U extends true ? {stdout: Buffer, stderr: Buffer} : {stdout: string, stderr: string}}
         */
        function getStdio(isBuffer) {
            let stdout, stderr;
            if (isBuffer) {
                stdout = Buffer.concat(stdoutArr);
                stderr = Buffer.concat(stderrArr);
            }
            else {
                stdout = Buffer.concat(stdoutArr).toString(opts.encoding);
                stderr = Buffer.concat(stderrArr).toString(opts.encoding);
            }
            return /** @type {U extends true ? {stdout: Buffer, stderr: Buffer} : {stdout: string, stderr: string}} */ ({ stdout, stderr });
        }
        // if the process ends, either resolve or reject the promise based on the
        // exit code of the process. either way, attach stdout, stderr, and code.
        // Also clean up the timer if it exists
        proc.on('close', (code) => {
            if (timer) {
                clearTimeout(timer);
            }
            let { stdout, stderr } = getStdio(isBuffer);
            if (code === 0) {
                resolve(/** @type {BufferProp<T> extends true ? AITProcessExecBufferResult : AITProcessExecStringResult} */ ({ stdout, stderr, code }));
            }
            else {
                let err = new Error(`Command '${rep}' exited with code ${code}`);
                err = Object.assign(err, { stdout, stderr, code });
                reject(err);
            }
        });
        // if we set a timeout on the child process, cut into the execution and
        // reject if the timeout is reached. Attach the stdout/stderr we currently
        // have in case it's helpful in debugging
        if (opts.timeout) {
            timer = setTimeout(() => {
                let { stdout, stderr } = getStdio(isBuffer);
                let err = new Error(`Command '${rep}' timed out after ${opts.timeout}ms`);
                err = Object.assign(err, { stdout, stderr, code: null });
                reject(err);
                // reject and THEN kill to avoid race conditions with the handlers
                // above
                proc.kill(opts.killSignal);
            }, opts.timeout);
        }
    });
}
exports.exec = exec;
exports.default = exec;
/**
 * Options on top of `SpawnOptions`, unique to `ait-process.`
 * @typedef {Object} AITProcessProps
 * @property {boolean} [ignoreOutput] - Ignore & discard all output
 * @property {boolean} [isBuffer] - Return output as a Buffer
 * @property {AITProcessLogger} [logger] - Logger to use for debugging
 * @property {number} [maxStdoutBufferSize] - Maximum size of `stdout` buffer
 * @property {number} [maxStderrBufferSize] - Maximum size of `stderr` buffer
 * @property {BufferEncoding} [encoding='utf8'] - Encoding to use for output
 */
/**
 * A logger object understood by {@link exec ait-process.exec}.
 * @typedef {Object} AITProcessLogger
 * @property {(...args: any[]) => void} debug
 */
/**
 * Options for {@link exec ait-process.exec}.
 * @typedef {import('child_process').SpawnOptions & AITProcessProps} AITProcessExecOptions
 */
/**
 * The value {@link exec ait-process.exec} resolves to when `isBuffer` is `false`
 * @typedef {Object} AITProcessExecStringResult
 * @property {string} stdout - Stdout
 * @property {string} stderr - Stderr
 * @property {number?} code - Exit code
 */
/**
 * The value {@link exec ait-process.exec} resolves to when `isBuffer` is `true`
 * @typedef {Object} AITProcessExecBufferResult
 * @property {Buffer} stdout - Stdout
 * @property {Buffer} stderr - Stderr
 * @property {number?} code - Exit code
 */
/**
 * Extra props {@link exec ait-process.exec} adds to its error objects
 * @typedef {Object} AITProcessExecErrorProps
 * @property {string} stdout - STDOUT
 * @property {string} stderr - STDERR
 * @property {number?} code - Exit code
 */
/**
 * Error thrown by {@link exec ait-process.exec}
 * @typedef {Error & AITProcessExecErrorProps} AITProcessExecError
 */
/**
 * @template {{isBuffer?: boolean}} MaybeBuffer
 * @typedef {MaybeBuffer['isBuffer']} BufferProp
 * @private
 */
//# sourceMappingURL=exec.js.map